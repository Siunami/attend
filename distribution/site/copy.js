const button = document.querySelector("[data-copy-prompt]");
const prompt = document.querySelector("#install-prompt");
const status = document.querySelector("#copy-status");

button?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(prompt?.textContent ?? "");
    button.textContent = "Copied";
    status.textContent = "Installation prompt copied to the clipboard.";
  } catch {
    prompt?.focus();
    status.textContent = "Clipboard access was unavailable. Select the prompt text and copy it manually.";
  }
});
