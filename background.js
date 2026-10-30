chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: 'https://www.youtube.com/feed/history' });
});
