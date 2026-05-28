import { GoogleAIFileManager } from "@google/generative-ai/server";

let fileManager: GoogleAIFileManager | null = null;

function getFileManager() {
  if (!fileManager) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY not set");
    fileManager = new GoogleAIFileManager(apiKey);
  }
  return fileManager;
}

export async function uploadToGemini(
  filePath: string,
  mimeType: string,
  displayName: string
) {
  const fm = getFileManager();
  const uploadResult = await fm.uploadFile(filePath, {
    mimeType,
    displayName,
  });
  return uploadResult.file;
}

export async function waitForFileProcessing(fileName: string) {
  const fm = getFileManager();
  let file = await fm.getFile(fileName);

  while (file.state === "PROCESSING") {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    file = await fm.getFile(fileName);
  }

  if (file.state === "FAILED") {
    throw new Error(`File processing failed: ${fileName}`);
  }

  return file;
}
