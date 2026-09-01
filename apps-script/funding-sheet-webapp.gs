const FUNDING_TABS = Object.freeze({
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
