// ================================================================
//  THU CHI PERSONAL — Google Apps Script Backend v2.2
//  Cập nhật: Xử lý lỗi chi tiết, hỗ trợ chẩn đoán từ frontend
// ================================================================

// ----------------------------------------------------------------
//  JSON RESPONSE HELPER
//  Lưu ý: GAS không hỗ trợ setHeader() — CORS được xử lý tự động
//  khi deploy với quyền "Mọi người"
// ----------------------------------------------------------------
function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ----------------------------------------------------------------
//  doGet
// ----------------------------------------------------------------
function doGet(e) {
  if (!e || !e.parameter) {
    return jsonResponse({ success: true, message: 'GAS đang chạy ✅', version: '2.2' });
  }

  const action = e.parameter.action;

  if (action === 'testConnection') {
    return jsonResponse({
      success: true,
      message: 'Kết nối GAS thành công! ✅',
      version: '2.2',
      time: new Date().toISOString()
    });
  }
  if (action === 'getReport')  return jsonResponse(getReport());
  if (action === 'getConfig')  return jsonResponse(getPublicConfig());

  // Mặc định: trả về JSON thông báo GAS đang chạy
  return jsonResponse({ success: true, message: 'GAS đang chạy ✅', version: '2.2' });
}

// ----------------------------------------------------------------
//  doPost
// ----------------------------------------------------------------
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({ success: false, message: 'Không nhận được dữ liệu POST — kiểm tra lại request từ frontend' });
    }

    let body;
    try {
      body = JSON.parse(e.postData.contents);
    } catch(parseErr) {
      return jsonResponse({ success: false, message: 'Dữ liệu POST không phải JSON hợp lệ: ' + parseErr.message });
    }

    const action = body.action;
    if (!action) {
      return jsonResponse({ success: false, message: 'Thiếu trường "action" trong request body' });
    }

    if (action === 'testConnection') {
      return jsonResponse({ success: true, message: 'POST kết nối thành công! ✅', method: 'POST' });
    }

    switch (action) {
      case 'saveConfig':      return jsonResponse(saveConfig(body.config));
      case 'analyze':         return jsonResponse(analyzeWithGemini(body.text));
      case 'saveTransaction': return jsonResponse(saveTransaction(body.data, body.settings));
      case 'askReport':       return jsonResponse(askAIReport(body.question));
      case 'searchTransactions': return jsonResponse(searchTransactions(body.keyword));
      default:                return jsonResponse({ success: false, message: 'Action không hợp lệ: "' + action + '"' });
    }
  } catch (err) {
    return jsonResponse({ success: false, message: 'Lỗi server GAS: ' + err.message });
  }
}

// ----------------------------------------------------------------
//  CONFIG
// ----------------------------------------------------------------
function saveConfig(config) {
  if (!config) return { success: false, message: 'Không nhận được dữ liệu config' };
  try {
    const props = PropertiesService.getScriptProperties();
    const saved = [];
    if (config.sheetId)        { props.setProperty('SHEET_ID', config.sheetId.trim()); saved.push('Sheet ID'); }
    if (config.geminiKey)      { props.setProperty('GEMINI_API_KEY', config.geminiKey.trim()); saved.push('Gemini Key'); }
    if (config.telegramToken)  { props.setProperty('TELEGRAM_BOT_TOKEN', config.telegramToken.trim()); saved.push('Telegram Token'); }
    if (config.telegramChatId) { props.setProperty('TELEGRAM_CHAT_ID', config.telegramChatId.trim()); saved.push('Telegram Chat ID'); }
    if (saved.length === 0) return { success: false, message: 'Không có trường nào được lưu — hãy nhập ít nhất một giá trị' };
    return { success: true, message: '✅ Đã lưu: ' + saved.join(', ') };
  } catch (e) {
    return { success: false, message: 'Lỗi lưu config: ' + e.message };
  }
}

function getConfig() {
  const props = PropertiesService.getScriptProperties();
  return {
    sheetId:        props.getProperty('SHEET_ID') || '',
    geminiKey:      props.getProperty('GEMINI_API_KEY') || '',
    telegramToken:  props.getProperty('TELEGRAM_BOT_TOKEN') || '',
    telegramChatId: props.getProperty('TELEGRAM_CHAT_ID') || ''
  };
}

function getPublicConfig() {
  const cfg = getConfig();
  return {
    success:      true,
    hasSheetId:   !!cfg.sheetId,
    hasGeminiKey: !!cfg.geminiKey,
    hasTelegram:  !!(cfg.telegramToken && cfg.telegramChatId),
    configured:   !!(cfg.sheetId && cfg.geminiKey)
  };
}

// ----------------------------------------------------------------
//  AI PHÂN TÍCH VĂN BẢN / GIỌNG NÓI
// ----------------------------------------------------------------
function analyzeWithGemini(userText) {
  if (!userText) return { success: false, message: 'Không có văn bản để phân tích' };
  const cfg = getConfig();
  if (!cfg.geminiKey) return { success: false, message: 'Chưa cấu hình Gemini API Key. Vào Cài đặt → Cấu Hình API để thêm key.' };

  const now = new Date();
  const pad = n => String(n).padStart(2,'0');
  const nowStr = `${pad(now.getDate())}/${pad(now.getMonth()+1)}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

  const prompt = `Bạn là trợ lý phân tích tài chính. Phân tích câu sau và trích xuất thông tin thu chi.
Thời gian hiện tại: ${nowStr}
Trả về JSON với format chính xác:
{
  "type": "thu" hoặc "chi",
  "ngay": "DD/MM/YYYY HH:MM",
  "soTien": số nguyên dương (VNĐ, không có dấu phẩy),
  "tenDoiTuong": "tên người hoặc cửa hàng",
  "diaChi": "địa chỉ nếu có, để trống nếu không có",
  "noiDung": "mô tả ngắn gọn nội dung giao dịch"
}
Quy tắc:
- "triệu" = 1000000, "ngàn/nghìn/k" = 1000, "trăm" = 100
- Nếu không rõ thu hay chi: câu có "mua/trả/chi/nộp" → chi; "bán/thu/nhận/được" → thu
- Chỉ trả về JSON thuần, không có markdown, không giải thích thêm.
Câu cần phân tích: "${userText}"`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${cfg.geminiKey}`;

  try {
    const response = UrlFetchApp.fetch(url, {
      method: 'POST',
      contentType: 'application/json',
      payload: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 500 }
      }),
      muteHttpExceptions: true
    });

    const httpCode = response.getResponseCode();
    if (httpCode !== 200) {
      return { success: false, message: `Gemini API lỗi HTTP ${httpCode} — Kiểm tra lại Gemini API Key` };
    }

    const data = JSON.parse(response.getContentText());
    if (data.error) return { success: false, message: 'Gemini từ chối: ' + data.error.message };

    const text = data.candidates[0].content.parts[0].text.trim();
    const clean = text.replace(/```json\n?|```\n?/g, '').trim();
    const parsed = JSON.parse(clean);
    return { success: true, parsed: parsed };
  } catch (e) {
    return { success: false, message: 'Lỗi phân tích AI: ' + e.message };
  }
}

// ----------------------------------------------------------------
//  LẤY STT TIẾP THEO
// ----------------------------------------------------------------
function getNextSTT(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 4) return 1;
  const data = sheet.getRange(4, 1, lastRow - 3, 1).getValues();
  let maxSTT = 0;
  data.forEach(row => {
    const v = parseInt(row[0]);
    if (!isNaN(v) && v > maxSTT) maxSTT = v;
  });
  return maxSTT + 1;
}

// ----------------------------------------------------------------
//  LƯU THU
// ----------------------------------------------------------------
function saveThu(data) {
  const cfg = getConfig();
  if (!cfg.sheetId) return { success: false, message: 'Chưa cấu hình Sheet ID. Vào Cài đặt để thêm.' };

  let ss;
  try {
    ss = SpreadsheetApp.openById(cfg.sheetId);
  } catch(e) {
    return { success: false, message: 'Không mở được Google Sheet — Sheet ID sai hoặc chưa chia sẻ quyền. Chi tiết: ' + e.message };
  }

  const sheet = ss.getSheetByName('THU');
  if (!sheet) return { success: false, message: 'Không tìm thấy sheet tên "THU". Hãy tạo sheet tên "THU" trong spreadsheet.' };

  const stt = getNextSTT(sheet);
  const dateVal = parseFlexDate(data.ngay);

  sheet.appendRow([
    stt, dateVal,
    Number(String(data.soTien).replace(/[^0-9]/g, '')),
    data.tenDoiTuong || '', data.diaChi || '', data.noiDung || ''
  ]);

  const lastRow = sheet.getLastRow();
  sheet.getRange(lastRow, 2).setNumberFormat('dd/MM/yyyy HH:mm');
  sheet.getRange(lastRow, 3).setNumberFormat('#,##0');

  return { success: true, message: `✅ Đã lưu THU: ${formatMoney(data.soTien)} từ ${data.tenDoiTuong}`, stt };
}

// ----------------------------------------------------------------
//  LƯU CHI
// ----------------------------------------------------------------
function saveChi(data) {
  const cfg = getConfig();
  if (!cfg.sheetId) return { success: false, message: 'Chưa cấu hình Sheet ID. Vào Cài đặt để thêm.' };

  let ss;
  try {
    ss = SpreadsheetApp.openById(cfg.sheetId);
  } catch(e) {
    return { success: false, message: 'Không mở được Google Sheet — Sheet ID sai hoặc chưa chia sẻ. Chi tiết: ' + e.message };
  }

  const sheet = ss.getSheetByName('CHI');
  if (!sheet) return { success: false, message: 'Không tìm thấy sheet tên "CHI". Hãy tạo sheet tên "CHI" trong spreadsheet.' };

  const stt = getNextSTT(sheet);
  const dateVal = parseFlexDate(data.ngay);

  sheet.appendRow([
    stt, dateVal,
    Number(String(data.soTien).replace(/[^0-9]/g, '')),
    data.tenDoiTuong || '', data.noiDung || ''
  ]);

  const lastRow = sheet.getLastRow();
  sheet.getRange(lastRow, 2).setNumberFormat('dd/MM/yyyy HH:mm');
  sheet.getRange(lastRow, 3).setNumberFormat('#,##0');

  return { success: true, message: `✅ Đã lưu CHI: ${formatMoney(data.soTien)} cho ${data.tenDoiTuong}`, stt };
}

// ----------------------------------------------------------------
//  LƯU GIAO DỊCH (gọi từ frontend)
// ----------------------------------------------------------------
function saveTransaction(data, settings) {
  if (!data) return { success: false, message: 'Không nhận được dữ liệu giao dịch' };
  try {
    let result;
    if (data.type === 'thu')       result = saveThu(data);
    else if (data.type === 'chi')  result = saveChi(data);
    else return { success: false, message: 'Loại giao dịch không hợp lệ: "' + data.type + '"' };

    if (result.success && settings && settings.telegram) {
      const emoji = data.type === 'thu' ? '💰' : '💸';
      const msg = `${emoji} <b>${data.type === 'thu' ? 'THU' : 'CHI'}</b>\n` +
        `💵 ${formatMoney(data.soTien)}\n👤 ${data.tenDoiTuong || '—'}\n` +
        `📝 ${data.noiDung || '—'}\n📅 ${data.ngay || 'Vừa xong'}`;
      sendTelegram(msg);
    }
    return result;
  } catch (e) {
    return { success: false, message: 'Lỗi lưu giao dịch: ' + e.message };
  }
}

// ----------------------------------------------------------------
//  TÌM KIẾM GIAO DỊCH
// ----------------------------------------------------------------
function searchTransactions(keyword) {
  if (!keyword) return { success: false, message: 'Vui lòng nhập từ khóa tìm kiếm' };
  const cfg = getConfig();
  if (!cfg.sheetId) return { success: false, message: 'Chưa cấu hình Sheet ID' };

  let ss;
  try { ss = SpreadsheetApp.openById(cfg.sheetId); }
  catch(e) { return { success: false, message: 'Không mở được Google Sheet: ' + e.message }; }

  const kw = keyword.toLowerCase().trim();
  const results = [];

  // Kiểm tra lọc theo tháng
  const now = new Date();
  let filterMonth = -1, filterYear = -1;
  if (kw.includes('tháng này')) {
    filterMonth = now.getMonth(); filterYear = now.getFullYear();
  } else if (kw.includes('tháng trước')) {
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    filterMonth = prev.getMonth(); filterYear = prev.getFullYear();
  }

  function searchSheet(sheetName, type) {
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) return;
    const data = sheet.getDataRange().getValues();
    for (let i = 3; i < data.length; i++) {
      const row = data[i];
      if (!row[0] || isNaN(parseInt(row[0]))) continue;

      const ngay    = row[1] instanceof Date ? row[1] : new Date(row[1]);
      const soTien  = Number(row[2]) || 0;
      const ten     = String(row[3] || '').toLowerCase();
      const col4    = String(row[4] || '').toLowerCase();
      const col5    = String(row[5] || '').toLowerCase();
      const soTienStr = soTien.toString();

      // Lọc theo tháng nếu có
      if (filterMonth >= 0) {
        if (isNaN(ngay.getTime())) continue;
        if (ngay.getMonth() !== filterMonth || ngay.getFullYear() !== filterYear) continue;
        results.push({ type, stt: row[0], ngay: _fmtDate(ngay), soTien, tenDoiTuong: row[3]||'', noiDung: (row[type==='thu'?5:4]||'') });
        continue;
      }

      // Tìm theo từ khóa
      if (ten.includes(kw) || col4.includes(kw) || col5.includes(kw) || soTienStr.includes(kw)) {
        results.push({ type, stt: row[0], ngay: _fmtDate(ngay), soTien, tenDoiTuong: row[3]||'', noiDung: (row[type==='thu'?5:4]||'') });
      }
    }
  }

  searchSheet('THU', 'thu');
  searchSheet('CHI', 'chi');

  // Sắp xếp mới nhất lên đầu
  results.sort((a, b) => new Date(b.ngay) - new Date(a.ngay));

  return { success: true, results: results.slice(0, 50), total: results.length };
}

function _fmtDate(d) {
  if (!d || isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2,'0');
  return `${p(d.getDate())}/${p(d.getMonth()+1)}/${d.getFullYear()}`;
}

// ----------------------------------------------------------------
//  BÁO CÁO
// ----------------------------------------------------------------
function getReport() {
  const cfg = getConfig();
  if (!cfg.sheetId) return { success: false, message: 'Chưa cấu hình Sheet ID' };

  try {
    let ss;
    try { ss = SpreadsheetApp.openById(cfg.sheetId); }
    catch(e) { return { success: false, message: 'Không mở được Google Sheet: ' + e.message }; }

    const thuSheet = ss.getSheetByName('THU');
    const chiSheet = ss.getSheetByName('CHI');
    if (!thuSheet) return { success: false, message: 'Không tìm thấy sheet "THU"' };
    if (!chiSheet) return { success: false, message: 'Không tìm thấy sheet "CHI"' };

    const thuData = thuSheet.getDataRange().getValues();
    const chiData = chiSheet.getDataRange().getValues();

    let tongThu = 0; const thuRows = [];
    for (let i = 3; i < thuData.length; i++) {
      const row = thuData[i];
      if (row[0] && !isNaN(parseInt(row[0])) && Number(row[2]) > 0) { tongThu += Number(row[2]); thuRows.push(row); }
    }

    let tongChi = 0; const chiRows = [];
    for (let i = 3; i < chiData.length; i++) {
      const row = chiData[i];
      if (row[0] && !isNaN(parseInt(row[0])) && Number(row[2]) > 0) { tongChi += Number(row[2]); chiRows.push(row); }
    }

    const monthlyStats = {};
    const addMonthly = (rows, type) => {
      rows.forEach(row => {
        const d = row[1] instanceof Date ? row[1] : new Date(row[1]);
        if (!isNaN(d.getTime())) {
          const key = `${d.getMonth()+1}/${d.getFullYear()}`;
          if (!monthlyStats[key]) monthlyStats[key] = { thu: 0, chi: 0 };
          monthlyStats[key][type] += Number(row[2]) || 0;
        }
      });
    };
    addMonthly(thuRows, 'thu'); addMonthly(chiRows, 'chi');

    const serializeRow = (row) => row.map(v => v instanceof Date ? v.toISOString() : v);

    return {
      success: true, tongThu, tongChi, loiNhuan: tongThu - tongChi,
      soGiaoDichThu: thuRows.length, soGiaoDichChi: chiRows.length,
      monthlyStats,
      recentThu: thuRows.slice(-5).reverse().map(serializeRow),
      recentChi: chiRows.slice(-5).reverse().map(serializeRow)
    };
  } catch (e) {
    return { success: false, message: 'Lỗi đọc báo cáo: ' + e.message };
  }
}

// ----------------------------------------------------------------
//  AI TRẢ LỜI CÂU HỎI BÁO CÁO
// ----------------------------------------------------------------
function askAIReport(question) {
  const cfg = getConfig();
  if (!cfg.geminiKey) return { success: false, message: 'Chưa cấu hình Gemini API Key' };
  const report = getReport();
  if (!report.success) return { success: false, message: 'Không lấy được dữ liệu: ' + report.message };

  const context = `Dữ liệu thu chi cá nhân:
Tổng Thu: ${formatMoney(report.tongThu)} (${report.soGiaoDichThu} giao dịch)
Tổng Chi: ${formatMoney(report.tongChi)} (${report.soGiaoDichChi} giao dịch)
Lợi Nhuận: ${formatMoney(report.loiNhuan)}
Theo tháng: ${JSON.stringify(report.monthlyStats)}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${cfg.geminiKey}`;
  try {
    const response = UrlFetchApp.fetch(url, {
      method: 'POST', contentType: 'application/json',
      payload: JSON.stringify({
        contents: [{ parts: [{ text: `Bạn là trợ lý tài chính cá nhân. Trả lời bằng tiếng Việt, ngắn gọn, có số liệu, dùng emoji.\n${context}\nCâu hỏi: ${question}` }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 600 }
      }),
      muteHttpExceptions: true
    });
    const httpCode = response.getResponseCode();
    if (httpCode !== 200) return { success: false, message: `Gemini lỗi HTTP ${httpCode}` };
    const data = JSON.parse(response.getContentText());
    if (data.error) return { success: false, message: data.error.message };
    return { success: true, answer: data.candidates[0].content.parts[0].text.trim(), reportData: report };
  } catch (e) {
    return { success: false, message: 'Lỗi AI: ' + e.message };
  }
}

// ----------------------------------------------------------------
//  GỬI TELEGRAM
// ----------------------------------------------------------------
function sendTelegram(message) {
  const cfg = getConfig();
  if (!cfg.telegramToken || !cfg.telegramChatId) return;
  try {
    UrlFetchApp.fetch(`https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`, {
      method: 'POST', contentType: 'application/json',
      payload: JSON.stringify({ chat_id: cfg.telegramChatId, text: message, parse_mode: 'HTML' }),
      muteHttpExceptions: true
    });
  } catch (e) { Logger.log('Telegram error: ' + e.message); }
}

// ----------------------------------------------------------------
//  TIỆN ÍCH
// ----------------------------------------------------------------
function formatMoney(n) { return Number(n).toLocaleString('vi-VN') + ' ₫'; }

function parseFlexDate(str) {
  if (!str) return new Date();
  if (str.includes('T')) return new Date(str);
  const m = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (m) return new Date(m[3], m[2]-1, m[1], m[4]||0, m[5]||0);
  return new Date();
}
