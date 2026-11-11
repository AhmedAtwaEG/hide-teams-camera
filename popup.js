const namesInput = document.getElementById('names');
const enabledInput = document.getElementById('enabled');
const status = document.getElementById('status');

chrome.storage.sync.get({ names: [], enabled: true }, ({ names, enabled }) => {
  namesInput.value = names.join('\n');
  enabledInput.checked = enabled;
});

document.getElementById('save').addEventListener('click', () => {
  const names = namesInput.value.split('\n').map((name) => name.trim()).filter(Boolean);
  chrome.storage.sync.set({ names, enabled: enabledInput.checked }, () => {
    status.textContent = 'Saved';
    setTimeout(() => { status.textContent = ''; }, 1500);
  });
});
