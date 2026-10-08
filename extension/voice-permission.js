document.getElementById('enable').onclick = async () => {
  const status = document.getElementById('status');
  try { const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); stream.getTracks().forEach(track => track.stop()); status.textContent = 'Microphone enabled. Return to the Autoum sidebar; you can close this tab.'; }
  catch (error) { status.textContent = 'Access was not granted. Allow microphone access in this page’s browser site settings and try again. ' + error.message; }
};
