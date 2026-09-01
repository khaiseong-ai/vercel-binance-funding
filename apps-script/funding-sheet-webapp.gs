const FUNDING_TABS = Object.freeze({
  overview: "Funding Overview",
  equity: "Account_Equity",
  funding: "Account_Funding",
  health: "Account_Health",
  runs: "Account_Runs"
});

const FUNDING_HEADERS = Object.freeze({
  equity: [
    "Checked At", "Exchange", "Futures USDT", "Futures USDC", "Spot USDT",
    "Spot USDC", "Funding USDT", "Funding USDC", "Unrealized PnL", "Total"
  ],
  funding: [
    "Checked At", "Symbol", "Source", "Side", "Size", "Current Price",
    "Entry Price", "Position Value", "uPnL", "Cnt", "Interval h", "3d Funding",
    "Funding Records", "Orders", "Start Time", "End Time"
  ],
  health: [
    "Checked At", "Class", "Symbol", "Net Funding", "Long Size", "Short Size",
    "Long Funding", "Short Funding", "Long Orders", "Short Orders", "Details"
  ],
  runs: [
    "Checked At", "Status", "Positions", "Exchanges", "Total Equity",
    "Elapsed ms", "Rows Written", "Error"
  ]
});

function doGet() {
  return jsonResponse_({ ok: true, service: "KS Vercel Funding Receiver" });
}

function doPost(event) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    const body = parseRequest_(event);
    const properties = PropertiesService.getScriptProperties();
    const expectedSecret = String(properties.getProperty("FUNDING_SHEET_SECRET") || "");
    const spreadsheetId = String(properties.getProperty("FUNDING_SPREADSHEET_ID") || "");

    if (!expectedSecret || !spreadsheetId) throw new Error("Receiver is not configured");
    if (body.action !== "writeAccountFunding") throw new Error("Unsupported action");
    if (String(body.secret || "") !== expectedSecret) throw new Error("Unauthorized");

    const snapshot = validateSnapshot_(body.snapshot);
    const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    const checkedAt = parseDate_(snapshot.checkedAt);
    const equityRows = buildEquityRows_(snapshot, checkedAt);
    const fundingRows = buildFundingRows_(snapshot, checkedAt);
    const healthRows = buildHealthRows_(snapshot, checkedAt);
    const rowsWritten = equityRows.length + fundingRows.length + healthRows.length;

    replaceRows_(spreadsheet, FUNDING_TABS.equity, FUNDING_HEADERS.equity, equityRows, {
      widths: [170, 100, 110, 110, 100, 100, 110, 110, 115, 115],
      dateColumns: [1],
      numericColumns: [3, 4, 5, 6, 7, 8, 9, 10]
    });
    replaceRows_(spreadsheet, FUNDING_TABS.funding, FUNDING_HEADERS.funding, fundingRows, {
      widths: [170, 90, 90, 70, 90, 105, 105, 115, 105, 60, 80, 105, 260, 240, 150, 150],
      dateColumns: [1, 15, 16],
      numericColumns: [5, 6, 7, 8, 9, 10, 11, 12]
    });
    replaceRows_(spreadsheet, FUNDING_TABS.health, FUNDING_HEADERS.health, healthRows, {
      widths: [170, 105, 90, 105, 95, 95, 105, 105, 90, 90, 280],
      dateColumns: [1],
      numericColumns: [4, 5, 6, 7, 8, 9, 10]
    });
    renderFundingOverview_(spreadsheet, snapshot, checkedAt);
    appendRun_(spreadsheet, [
      checkedAt,
      "OK",
      snapshot.positions.length,
      snapshot.equity.length,
      number_(snapshot.totalEquity),
      integer_(snapshot.elapsedMs),
      rowsWritten,
      ""
    ]);

    SpreadsheetApp.flush();
    return jsonResponse_({ ok: true, rowsWritten: rowsWritten });
  } catch (error) {
    return jsonResponse_({ ok: false, error: String(error && error.message || error) });
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

function parseRequest_(event) {
  const text = event && event.postData && event.postData.contents;
  if (!text || text.length > 5000000) throw new Error("Invalid request body");
  return JSON.parse(text);
}

function validateSnapshot_(snapshot) {
  if (!snapshot || snapshot.success !== true) throw new Error("Invalid snapshot");
  if (!Array.isArray(snapshot.equity) || snapshot.equity.length > 50) {
    throw new Error("Invalid equity rows");
  }
  if (!Array.isArray(snapshot.positions) || snapshot.positions.length > 2000) {
    throw new Error("Invalid funding rows");
  }
  const health = snapshot.hedgeHealth || {};
  ["noProtection", "fundingLoss", "misaligned"].forEach(function (name) {
    if (!Array.isArray(health[name] || []) || (health[name] || []).length > 2000) {
      throw new Error("Invalid health rows");
    }
  });
  parseDate_(snapshot.checkedAt);
  return snapshot;
}

function buildEquityRows_(snapshot, checkedAt) {
  return snapshot.equity.map(function (row) {
    return [
      checkedAt,
      safeText_(row.exchange),
      number_(row.futuresUsdt),
      number_(row.futuresUsdc),
      number_(row.spotUsdt),
      number_(row.spotUsdc),
      number_(row.fundingUsdt),
      number_(row.fundingUsdc),
      number_(row.unrealizedPnl),
      number_(row.total)
    ];
  });
}

function buildFundingRows_(snapshot, checkedAt) {
  return snapshot.positions.map(function (row) {
    return [
      checkedAt,
      safeText_(row.symbol),
      safeText_(row.source),
      safeText_(row.side),
      number_(row.positionSize),
      number_(row.currentPrice),
      number_(row.entryPrice),
      number_(row.positionValue),
      number_(row.unrealizedPnl),
      integer_(row.count),
      number_(row.fundingIntervalHours),
      number_(row.totalFunding),
      safeText_(JSON.stringify(row.fundingRecords || [])),
      safeText_(JSON.stringify(row.orders || [])),
      optionalDate_(row.startTime),
      optionalDate_(row.endTime)
    ];
  });
}

function buildHealthRows_(snapshot, checkedAt) {
  const health = snapshot.hedgeHealth || {};
  const rows = [];
  [
    ["No Protection", health.noProtection || []],
    ["Funding Loss", health.fundingLoss || []],
    ["Misaligned", health.misaligned || []]
  ].forEach(function (group) {
    group[1].forEach(function (row) {
      rows.push([
        checkedAt,
        group[0],
        safeText_(row.symbol),
        number_(row.netFunding),
        number_(row.longSize),
        number_(row.shortSize),
        number_(row.longFunding),
        number_(row.shortFunding),
        integer_(row.longOrderCount),
        integer_(row.shortOrderCount),
        safeText_((row.problems || []).join("; "))
      ]);
    });
  });
  return rows;
}

function renderFundingOverview_(spreadsheet, snapshot, checkedAt) {
  const sheet = getOrCreateSheet_(spreadsheet, FUNDING_TABS.overview);
  const positions = snapshot.positions.slice().sort(function (a, b) {
    const symbolOrder = safeText_(a.symbol).localeCompare(safeText_(b.symbol));
    if (symbolOrder !== 0) return symbolOrder;
    const sideOrder = sideRank_(a.side) - sideRank_(b.side);
    if (sideOrder !== 0) return sideOrder;
    return safeText_(a.source).localeCompare(safeText_(b.source));
  });
  const grouped = groupPositions_(positions);
  const symbols = Object.keys(grouped).sort();
  const totalLong = positions.reduce(function (sum, row) {
    return sum + (safeText_(row.side).toLowerCase() === "long" ? number_(row.positionValue) : 0);
  }, 0);
  const totalShort = positions.reduce(function (sum, row) {
    return sum + (safeText_(row.side).toLowerCase() === "short" ? number_(row.positionValue) : 0);
  }, 0);
  const netPnl = positions.reduce(function (sum, row) { return sum + number_(row.unrealizedPnl); }, 0);
  const netFunding = positions.reduce(function (sum, row) { return sum + number_(row.totalFunding); }, 0);
  const health = snapshot.hedgeHealth || {};
  const dateWindow = fundingDateWindow_(positions);

  const equityStartRow = 12;
  const equityHeaderRow = equityStartRow + 1;
  const equityDataStartRow = equityHeaderRow + 1;
  const equityRows = snapshot.equity.map(function (row) {
    const exchange = safeText_(row.exchange);
    const futures = number_(row.futuresUsdt) + number_(row.futuresUsdc);
    const spotFunding = number_(row.spotUsdt) + number_(row.spotUsdc)
      + number_(row.fundingUsdt) + number_(row.fundingUsdc);
    const exchangePositions = positions.filter(function (position) {
      return safeText_(position.source).toLowerCase() === exchange.toLowerCase();
    });
    const longValue = exchangePositions.reduce(function (sum, position) {
      return sum + (safeText_(position.side).toLowerCase() === "long" ? number_(position.positionValue) : 0);
    }, 0);
    const shortValue = exchangePositions.reduce(function (sum, position) {
      return sum + (safeText_(position.side).toLowerCase() === "short" ? number_(position.positionValue) : 0);
    }, 0);
    return [exchange, futures, spotFunding, number_(row.total), longValue, shortValue];
  });
  const equityTotal = equityRows.reduce(function (total, row) {
    for (let index = 1; index < row.length; index += 1) total[index] += number_(row[index]);
    return total;
  }, ["Total", 0, 0, 0, 0, 0]);
  const fundingSectionRow = equityDataStartRow + equityRows.length + 2;
  const fundingHeaderRow = fundingSectionRow + 1;
  const fundingDataStartRow = fundingHeaderRow + 1;
  const fundingRows = [];
  const groupRanges = [];
  const recordRichText = [];
  const rowHeights = [];

  symbols.forEach(function (symbol, symbolIndex) {
    const entries = grouped[symbol];
    const groupStart = fundingDataStartRow + fundingRows.length;
    const pairFunding = entries.reduce(function (sum, row) { return sum + number_(row.totalFunding); }, 0);
    const showIntervals = new Set(entries.map(function (row) { return integer_(row.count); })).size > 1;
    entries.forEach(function (row, index) {
      const records = Array.isArray(row.fundingRecords) ? row.fundingRecords : [];
      const orders = Array.isArray(row.orders) ? row.orders : [];
      const recordText = formatFundingRecords_(records);
      const orderText = formatOrders_(orders);
      const interval = number_(row.fundingIntervalHours);
      const countLabel = String(integer_(row.count))
        + (showIntervals && interval > 0 ? " (" + flexibleNumber_(interval, 2) + "h)" : "");
      fundingRows.push([
        index === 0 ? symbol : "",
        index === 0 ? pairFunding : "",
        safeText_(row.source),
        number_(row.currentPrice),
        safeText_(row.side).toLowerCase(),
        number_(row.positionSize),
        number_(row.positionValue),
        number_(row.unrealizedPnl),
        countLabel,
        recordText,
        number_(row.totalFunding),
        orderText
      ]);
      recordRichText.push(buildFundingRichText_(records));
      rowHeights.push(Math.max(30, Math.ceil(Math.max(records.length, orders.length * 3) / 3) * 17 + 8));
    });
    groupRanges.push({
      start: groupStart,
      count: entries.length,
      pairFunding: pairFunding,
      background: symbolIndex % 2 === 0 ? "#FFFFFF" : "#F2F2F2"
    });
  });

  const totalsRow = fundingDataStartRow + fundingRows.length;
  const requiredRows = Math.max(100, totalsRow + 5);
  if (sheet.getMaxRows() < requiredRows) sheet.insertRowsAfter(sheet.getMaxRows(), requiredRows - sheet.getMaxRows());
  if (sheet.getMaxColumns() < 12) sheet.insertColumnsAfter(sheet.getMaxColumns(), 12 - sheet.getMaxColumns());
  sheet.getDataRange().breakApart();
  sheet.clear();
  sheet.setHiddenGridlines(true);
  sheet.setFrozenRows(2);
  sheet.setTabColor("#1A7F37");

  sheet.getRange("A1:L1").merge().setValue("Funding Fee Overview");
  sheet.getRange("A2:L2").merge().setValue(
    "Updated " + Utilities.formatDate(checkedAt, Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss")
      + "  |  3-day window " + dateWindow
  );

  const statCards = [
    { range: "A4:B4", valueRange: "A5:B5", label: "Total Equity", value: number_(snapshot.totalEquity), format: "$#,##0.00" },
    { range: "C4:D4", valueRange: "C5:D5", label: "Symbols / Positions", value: symbols.length + " / " + positions.length },
    { range: "E4:G4", valueRange: "E5:G5", label: "Total Position Value", value: totalLong + totalShort, format: "$#,##0.00" },
    { range: "H4:J4", valueRange: "H5:J5", label: "72h Funding / uPnL", value: compactNumber_(netFunding, 2) + " / " + compactNumber_(netPnl, 2) },
    { range: "K4:L4", valueRange: "K5:L5", label: "Hedge Issues", value: (health.noProtection || []).length + " / " + (health.fundingLoss || []).length + " / " + (health.misaligned || []).length }
  ];
  statCards.forEach(function (card) {
    sheet.getRange(card.range).merge().setValue(card.label);
    const valueRange = sheet.getRange(card.valueRange).merge().setValue(card.value);
    if (card.format) valueRange.setNumberFormat(card.format);
  });
  sheet.getRange("H5:J5").setFontColor(netFunding >= 0 ? "#1A7F37" : "#CF222E");

  sheet.getRange("A7:L7").merge().setValue("Hedge Health");
  const healthCards = [
    { header: "A8:D8", body: "A9:D10", label: "No TP/SL Protection", rows: health.noProtection || [], color: "#CF222E" },
    { header: "E8:H8", body: "E9:H10", label: "Funding Loss", rows: health.fundingLoss || [], color: "#9A6700" },
    { header: "I8:L8", body: "I9:L10", label: "Size / Order Misaligned", rows: health.misaligned || [], color: "#BC4C00" }
  ];
  healthCards.forEach(function (card) {
    sheet.getRange(card.header).merge().setValue(card.label + " (" + card.rows.length + ")").setFontColor(card.color);
    sheet.getRange(card.body).merge().setValue(healthSymbols_(card.rows)).setWrap(true);
  });

  sheet.getRange(equityStartRow, 1, 1, 12).merge().setValue("Exchange Equity");
  sheet.getRange(equityHeaderRow, 1, 1, 6).setValues([[
    "Exchange", "Futures USD", "Spot / Funding USD", "Total", "Long Pos", "Short Pos"
  ]]);
  if (equityRows.length) sheet.getRange(equityDataStartRow, 1, equityRows.length, 6).setValues(equityRows);
  sheet.getRange(equityDataStartRow + equityRows.length, 1, 1, 6).setValues([equityTotal]);

  sheet.getRange(fundingSectionRow, 1, 1, 12).merge().setValue("Positions & Funding");
  sheet.getRange(fundingHeaderRow, 1, 1, 12).setValues([[
    "Symbol", "Pair", "Source", "Price", "Side", "Size", "Position Value", "uPnL",
    "Cnt", "Funding Records", "Total Funding", "Orders"
  ]]);
  if (fundingRows.length) {
    sheet.getRange(fundingDataStartRow, 1, fundingRows.length, 12).setValues(fundingRows);
    sheet.getRange(fundingDataStartRow, 10, recordRichText.length, 1)
      .setRichTextValues(recordRichText.map(function (value) { return [value]; }));
  }
  sheet.getRange(totalsRow, 1, 1, 12).setValues([[
    "Totals", "", "", "", "", "", totalLong + totalShort, netPnl, "", "", netFunding, ""
  ]]);

  groupRanges.forEach(function (group) {
    sheet.getRange(group.start, 3, group.count, 10).setBackground(group.background);
    sheet.getRange(group.start, 1, group.count, 1).merge().setBackground("#EEEEEE");
    sheet.getRange(group.start, 2, group.count, 1).merge().setBackground("#EEEEEE")
      .setFontColor(group.pairFunding >= 0 ? "#1A7F37" : "#CF222E");
  });
  rowHeights.forEach(function (height, index) { sheet.setRowHeight(fundingDataStartRow + index, height); });
  styleFundingOverview_(sheet, {
    equityHeaderRow: equityHeaderRow,
    equityDataStartRow: equityDataStartRow,
    equityRowCount: equityRows.length,
    fundingSectionRow: fundingSectionRow,
    fundingHeaderRow: fundingHeaderRow,
    fundingDataStartRow: fundingDataStartRow,
    fundingRowCount: fundingRows.length,
    totalsRow: totalsRow,
    positions: fundingRows
  });
  spreadsheet.setActiveSheet(sheet);
  spreadsheet.moveActiveSheet(1);
}

function styleFundingOverview_(sheet, layout) {
  const headerBackground = "#333333";
  const borderColor = "#CCCCCC";
  sheet.getRange("A1:L1")
    .setBackground("#F9F9F9").setFontColor("#1F2328").setFontSize(20).setFontWeight("bold")
    .setHorizontalAlignment("left").setVerticalAlignment("middle");
  sheet.getRange("A2:L2")
    .setBackground("#F9F9F9").setFontColor("#656D76").setFontSize(10).setHorizontalAlignment("left");
  sheet.setRowHeight(1, 36);
  sheet.setRowHeight(2, 25);

  ["A4:B4", "C4:D4", "E4:G4", "H4:J4", "K4:L4"].forEach(function (a1) {
    sheet.getRange(a1).setBackground("#F2F2F2").setFontColor("#656D76")
      .setFontWeight("bold").setFontSize(10).setHorizontalAlignment("center");
  });
  ["A5:B5", "C5:D5", "E5:G5", "H5:J5", "K5:L5"].forEach(function (a1) {
    sheet.getRange(a1).setBackground("#FFFFFF").setFontColor("#1F2328")
      .setFontWeight("bold").setFontSize(15).setHorizontalAlignment("center")
      .setBorder(true, true, true, true, false, false, borderColor, SpreadsheetApp.BorderStyle.SOLID);
  });
  [7, 12, layout.fundingSectionRow].forEach(function (row) {
    sheet.getRange(row, 1, 1, 12).setBackground("#F2F2F2").setFontColor("#1F2328")
      .setFontWeight("bold").setFontSize(11).setHorizontalAlignment("left")
      .setBorder(true, true, true, true, false, false, borderColor, SpreadsheetApp.BorderStyle.SOLID);
    sheet.setRowHeight(row, 30);
  });
  ["A8:D8", "E8:H8", "I8:L8"].forEach(function (a1) {
    sheet.getRange(a1).setBackground("#F2F2F2").setFontWeight("bold").setHorizontalAlignment("center");
  });
  ["A9:D10", "E9:H10", "I9:L10"].forEach(function (a1) {
    sheet.getRange(a1).setBackground("#FFFFFF").setFontSize(10).setFontColor("#656D76")
      .setVerticalAlignment("top").setHorizontalAlignment("left")
      .setBorder(true, true, true, true, false, false, borderColor, SpreadsheetApp.BorderStyle.SOLID);
  });

  [layout.equityHeaderRow, layout.fundingHeaderRow].forEach(function (row) {
    const columns = row === layout.equityHeaderRow ? 6 : 12;
    sheet.getRange(row, 1, 1, columns).setBackground(headerBackground).setFontColor("#FFFFFF")
      .setFontWeight("bold").setHorizontalAlignment("center").setVerticalAlignment("middle")
      .setWrap(true).setBorder(true, true, true, true, true, true, borderColor, SpreadsheetApp.BorderStyle.SOLID);
    sheet.setRowHeight(row, 34);
  });
  if (layout.equityRowCount) {
    const equityBody = sheet.getRange(layout.equityDataStartRow, 1, layout.equityRowCount, 6);
    equityBody.setFontSize(10).setVerticalAlignment("middle")
      .setBorder(true, true, true, true, true, true, borderColor, SpreadsheetApp.BorderStyle.SOLID);
    sheet.getRange(layout.equityDataStartRow, 2, layout.equityRowCount + 1, 5)
      .setNumberFormat("#,##0.00;[Red]-#,##0.00;0.00").setHorizontalAlignment("right");
    for (let index = 0; index < layout.equityRowCount; index += 1) {
      if (index % 2 === 1) sheet.getRange(layout.equityDataStartRow + index, 1, 1, 6).setBackground("#F2F2F2");
    }
  }
  const equityTotalRow = layout.equityDataStartRow + layout.equityRowCount;
  sheet.getRange(equityTotalRow, 1, 1, 6).setFontWeight("bold").setBackground("#FFFFFF")
    .setBorder(true, true, true, true, true, true, borderColor, SpreadsheetApp.BorderStyle.SOLID);
  sheet.getRange(equityTotalRow, 5).setFontColor("#1A7F37");
  sheet.getRange(equityTotalRow, 6).setFontColor("#CF222E");

  if (layout.fundingRowCount) {
    const body = sheet.getRange(layout.fundingDataStartRow, 1, layout.fundingRowCount, 12);
    body.setFontSize(10).setVerticalAlignment("top").setWrap(true)
      .setBorder(true, true, true, true, true, true, borderColor, SpreadsheetApp.BorderStyle.SOLID);
    sheet.getRange(layout.fundingDataStartRow, 1, layout.fundingRowCount, 2)
      .setFontWeight("bold").setHorizontalAlignment("center").setVerticalAlignment("middle");
    sheet.getRange(layout.fundingDataStartRow, 4, layout.fundingRowCount, 1).setNumberFormat("#,##0.0000").setHorizontalAlignment("right");
    sheet.getRange(layout.fundingDataStartRow, 6, layout.fundingRowCount, 1).setNumberFormat("#,##0.####").setHorizontalAlignment("right");
    sheet.getRange(layout.fundingDataStartRow, 7, layout.fundingRowCount, 2).setNumberFormat("#,##0.00;[Red]-#,##0.00;0.00").setHorizontalAlignment("right");
    sheet.getRange(layout.fundingDataStartRow, 9, layout.fundingRowCount, 1).setHorizontalAlignment("center");
    sheet.getRange(layout.fundingDataStartRow, 11, layout.fundingRowCount, 1).setNumberFormat("#,##0.00;[Red]-#,##0.00;0.00").setHorizontalAlignment("right");
    sheet.getRange(layout.fundingDataStartRow, 5, layout.fundingRowCount, 1).setFontColors(
      layout.positions.map(function (row) { return [row[4] === "long" ? "#1A7F37" : "#CF222E"]; })
    ).setFontWeight("bold").setHorizontalAlignment("center");
    sheet.getRange(layout.fundingDataStartRow, 8, layout.fundingRowCount, 1).setFontColors(
      layout.positions.map(function (row) { return [number_(row[7]) >= 0 ? "#1A7F37" : "#CF222E"]; })
    );
    sheet.getRange(layout.fundingDataStartRow, 11, layout.fundingRowCount, 1).setFontColors(
      layout.positions.map(function (row) { return [number_(row[10]) >= 0 ? "#1A7F37" : "#CF222E"]; })
    );
  }
  sheet.getRange(layout.totalsRow, 1, 1, 12).setFontWeight("bold").setBackground("#FFFFFF")
    .setBorder(true, true, true, true, true, true, borderColor, SpreadsheetApp.BorderStyle.SOLID);
  sheet.getRange(layout.totalsRow, 7, 1, 2).setNumberFormat("#,##0.00;[Red]-#,##0.00;0.00");
  sheet.getRange(layout.totalsRow, 11).setNumberFormat("#,##0.00;[Red]-#,##0.00;0.00");

  const widths = [90, 85, 90, 95, 70, 100, 115, 105, 80, 285, 110, 260];
  widths.forEach(function (width, index) { sheet.setColumnWidth(index + 1, width); });
}

function groupPositions_(positions) {
  return positions.reduce(function (groups, row) {
    const symbol = safeText_(row.symbol);
    if (!groups[symbol]) groups[symbol] = [];
    groups[symbol].push(row);
    return groups;
  }, {});
}

function sideRank_(side) {
  return safeText_(side).toLowerCase() === "short" ? 0 : 1;
}

function healthSymbols_(rows) {
  if (!rows.length) return "None";
  return rows.map(function (row) { return safeText_(row.symbol); }).filter(Boolean).join("  |  ");
}

function fundingDateWindow_(positions) {
  const starts = positions.map(function (row) { return new Date(row.startTime); })
    .filter(function (date) { return !isNaN(date.getTime()); });
  const ends = positions.map(function (row) { return new Date(row.endTime); })
    .filter(function (date) { return !isNaN(date.getTime()); });
  if (!starts.length || !ends.length) return "latest 72h";
  const start = new Date(Math.min.apply(null, starts.map(function (date) { return date.getTime(); })));
  const end = new Date(Math.max.apply(null, ends.map(function (date) { return date.getTime(); })));
  return Utilities.formatDate(start, Session.getScriptTimeZone(), "MM-dd HH:mm")
    + " -> " + Utilities.formatDate(end, Session.getScriptTimeZone(), "MM-dd HH:mm");
}

function formatFundingRecords_(records) {
  if (!records.length) return "";
  const lines = [];
  for (let index = 0; index < records.length; index += 3) {
    lines.push(records.slice(index, index + 3).map(function (value) {
      return compactNumber_(number_(value), 2);
    }).join("     "));
  }
  return lines.join("\n");
}

function buildFundingRichText_(records) {
  const text = formatFundingRecords_(records);
  const builder = SpreadsheetApp.newRichTextValue().setText(text);
  const matches = [];
  const pattern = /-?\d[\d,.]*/g;
  let match;
  while ((match = pattern.exec(text)) !== null) matches.push(match);
  matches.forEach(function (numberMatch) {
    const value = Number(numberMatch[0].replace(/,/g, ""));
    const color = value > 0 ? "#1A7F37" : value < 0 ? "#CF222E" : "#656D76";
    const style = SpreadsheetApp.newTextStyle().setForegroundColor(color).build();
    builder.setTextStyle(numberMatch.index, numberMatch.index + numberMatch[0].length, style);
  });
  return builder.build();
}

function formatOrders_(orders) {
  if (!orders.length) return "-";
  return orders.map(function (order) {
    const price = number_(order.triggerPrice) > 0 ? number_(order.triggerPrice) : number_(order.price);
    const amount = number_(order.amount);
    return [
      safeText_(order.side).toLowerCase() + "  " + safeText_(order.kind || "LIMIT"),
      compactNumber_(price, price >= 1 ? 4 : 6) + "  x" + compactNumber_(amount, amount > 0 && amount < 1 ? 4 : 0)
    ].join("\n");
  }).join("\n");
}

function compactNumber_(value, decimals) {
  return number_(value).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

function flexibleNumber_(value, decimals) {
  return number_(value).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals
  });
}

function replaceRows_(spreadsheet, name, headers, rows, options) {
  const sheet = getOrCreateSheet_(spreadsheet, name);
  if (sheet.getFilter()) sheet.getFilter().remove();
  sheet.clearContents();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (rows.length) sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  styleSheet_(sheet, headers.length, rows.length, options);
}

function appendRun_(spreadsheet, row) {
  const sheet = getOrCreateSheet_(spreadsheet, FUNDING_TABS.runs);
  const headers = FUNDING_HEADERS.runs;
  const firstValue = String(sheet.getRange(1, 1).getDisplayValue() || "");
  if (firstValue !== headers[0]) {
    sheet.clearContents();
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  sheet.appendRow(row);
  if (sheet.getLastRow() > 1001) {
    sheet.deleteRows(2, sheet.getLastRow() - 1001);
  }
  styleSheet_(sheet, headers.length, Math.max(0, sheet.getLastRow() - 1), {
    widths: [170, 90, 80, 85, 115, 90, 95, 340],
    dateColumns: [1],
    numericColumns: [3, 4, 5, 6, 7]
  });
}

function styleSheet_(sheet, columnCount, rowCount, options) {
  if (sheet.getFilter()) sheet.getFilter().remove();
  const header = sheet.getRange(1, 1, 1, columnCount);
  header
    .setBackground("#303030")
    .setFontColor("#FFFFFF")
    .setFontWeight("bold")
    .setVerticalAlignment("middle")
    .setWrap(true);
  sheet.setRowHeight(1, 34);
  sheet.setFrozenRows(1);
  sheet.setHiddenGridlines(true);
  (options.widths || []).forEach(function (width, index) {
    sheet.setColumnWidth(index + 1, width);
  });
  if (rowCount > 0) {
    const body = sheet.getRange(2, 1, rowCount, columnCount);
    body.setVerticalAlignment("middle").setFontSize(10);
    (options.dateColumns || []).forEach(function (column) {
      sheet.getRange(2, column, rowCount, 1).setNumberFormat("yyyy-mm-dd hh:mm:ss");
    });
    (options.numericColumns || []).forEach(function (column) {
      sheet.getRange(2, column, rowCount, 1).setNumberFormat("#,##0.00;[Red]-#,##0.00;0.00");
    });
    sheet.getRange(1, 1, rowCount + 1, columnCount).createFilter();
  }
}

function getOrCreateSheet_(spreadsheet, name) {
  return spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
}

function parseDate_(value) {
  const date = new Date(String(value || ""));
  if (isNaN(date.getTime())) throw new Error("Invalid checkedAt");
  return date;
}

function optionalDate_(value) {
  if (!value) return "";
  const date = new Date(String(value));
  return isNaN(date.getTime()) ? safeText_(value) : date;
}

function number_(value) {
  const parsed = Number(value);
  return isFinite(parsed) ? parsed : 0;
}

function integer_(value) {
  return Math.max(0, Math.floor(number_(value)));
}

function safeText_(value) {
  const text = String(value == null ? "" : value);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function jsonResponse_(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
