import dotenv from 'dotenv';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';

const repoRoot = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(repoRoot, '.env.local') });

async function checkKeys() {
  const keys: string[] = [];
  const primaryKey = process.env.GEMINI_API_KEY;
  if (primaryKey && primaryKey.startsWith('AIza') && primaryKey.length > 20) {
    keys.push(primaryKey);
  }
  for (let i = 1; i <= 100; i++) {
    const val = process.env[`GEMINI_API_KEY_${i}`];
    if (val && val.startsWith('AIza') && val.length > 20) {
      keys.push(val);
    }
  }

  const uniqueKeys = Array.from(new Set(keys));
  console.log(`Checking ${uniqueKeys.length} Gemini API keys...`);

  const results = [];
  for (let i = 0; i < uniqueKeys.length; i++) {
    const key = uniqueKeys[i];
    const keyLabel = `Key ${i + 1}/${uniqueKeys.length} (${key.substring(0, 8)}...)`;
    
    try {
      const ai = new GoogleGenAI({ apiKey: key });
      // Call a very small model query
      const response = await ai.models.generateContent({
        model: 'gemini-3.5-flash',
        contents: 'hi',
      });
      console.log(`🟢 ${keyLabel}: VALID (Result: "${response.text?.trim()}")`);
      results.push({ index: i, valid: true });
    } catch (err: any) {
      console.warn(`🔴 ${keyLabel}: FAILED - ${err.message}`);
      results.push({ index: i, valid: false, error: err.message });
    }
  }

  const validCount = results.filter(r => r.valid).length;
  console.log(`\n==================================================`);
  console.log(`Summary: ${validCount}/${uniqueKeys.length} keys are working.`);
  console.log(`==================================================`);
}

checkKeys();
