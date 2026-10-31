document.getElementById("go").onclick = async () => {
  const out = document.getElementById("out");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    out.textContent = "Microphone allowed. You can close this tab.";
  } catch (e) {
    out.textContent = `Not allowed: ${e.message}`;
  }
};
