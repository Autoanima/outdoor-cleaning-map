/*
 * 網站設定
 *
 * gasUrl     ：Google Apps Script 部署後的「網頁應用程式網址」（…/exec）
 *              放在公開的 GitHub 上沒關係，因為還需要密碼才能讀寫資料。
 * resetHours ：幾小時後自動清空本次紀錄
 *
 * ⚠ 密碼不要寫在這裡，因為 GitHub 上的檔案所有人都看得到。
 */
window.APP_CONFIG = {
  gasUrl: 'https://script.google.com/macros/s/AKfycbw9tBHBF5s8PeAWzFUNy84FRlv7r93m9KOP05dkbEzTiH7NAge4tpfPrhESgBFyfe3N/exec',
  resetHours: 20,
};
