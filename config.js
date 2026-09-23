/*
 * 網站設定（可不填，也能在網頁右上角「⚙ 設定」裡輸入，會存在各自的手機上）
 *
 * gasUrl     ：Google Apps Script 部署後的「網頁應用程式網址」（…/exec）
 *              這個網址放在公開的 GitHub 上沒關係，因為還需要通關密碼才能寫入。
 * resetHours ：幾小時後自動清空本次紀錄
 *
 * ⚠ 通關密碼（token）請不要寫在這裡，因為 GitHub 上的檔案所有人都看得到。
 */
window.APP_CONFIG = {
  gasUrl: '',
  resetHours: 20,
};
