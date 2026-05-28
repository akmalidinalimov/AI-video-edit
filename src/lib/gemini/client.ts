import { GoogleGenerativeAI } from "@google/generative-ai";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  throw new Error("GEMINI_API_KEY environment variable is not set");
}

const genAI = new GoogleGenerativeAI(apiKey);

export const geminiFlash = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  generationConfig: {
    temperature: 0.1,
    responseMimeType: "application/json",
  },
});

export const geminiPro = genAI.getGenerativeModel({
  model: "gemini-2.5-pro",
  generationConfig: {
    temperature: 0.1,
    responseMimeType: "application/json",
  },
});

/** Fallback model on newer Gemini 3.x infrastructure */
export const geminiFallback = genAI.getGenerativeModel({
  model: "gemini-3.1-pro-preview",
  generationConfig: {
    temperature: 0.1,
    responseMimeType: "application/json",
  },
});

export { genAI };
