document.querySelector('#open-sidebar').addEventListener('click', () => {
  chrome.windows.getCurrent().then(window => chrome.sidePanel.open({ windowId: window.id })).catch(error => {
    document.querySelector('#status').textContent = 'Use the Autoum toolbar icon to open the sidebar. ' + error.message;
  });
});
