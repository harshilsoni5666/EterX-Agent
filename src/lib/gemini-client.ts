import { GoogleGenerativeAI } from "@google/generative-ai";

const API_KEYS = [
  process.env.VITE_SEARCH_API_KEY_1,
  process.env.VITE_SEARCH_API_KEY_2,
  process.env.VITE_SEARCH_API_KEY_3,
  process.env.VITE_SEARCH_API_KEY_4,
  process.env.VITE_SEARCH_API_KEY_5,
  process.env.VITE_SEARCH_API_KEY_6,
  process.env.VITE_SEARCH_API_KEY_7,
  process.env.VITE_SEARCH_API_KEY_8,
  process.env.VITE_SEARCH_API_KEY_9,
  process.env.VITE_SEARCH_API_KEY_10,
  process.env.VITE_SEARCH_API_KEY_11,
  process.env.VITE_SEARCH_API_KEY_12,
].filter(Boolean) as string[];

let currentKeyIndex = 0;

export function getGeminiClient() {
  const apiKey = API_KEYS[currentKeyIndex];
  currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;
  return new GoogleGenerativeAI(apiKey);
}
