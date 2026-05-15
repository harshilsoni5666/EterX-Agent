import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import crypto from 'node:crypto';

/**
 * Crypto & Encoding Utilities
 * 
 * Hashing, encoding/decoding, UUID generation, password generation,
 * and data validation. Essential for security, development, and DevOps.
 */
export const cryptoTool: ToolDefinition = {
  name: 'crypto_utils',
  description: `Cryptographic and encoding utilities: hash text (MD5/SHA256/SHA512), encode/decode Base64, generate UUIDs, create secure passwords, generate HMAC signatures, and encode/decode URLs. Essential for security work, API auth, and data processing.`,
  category: 'core',
  inputSchema: z.object({
    operation: z.enum([
      'hash_md5', 'hash_sha256', 'hash_sha512',
      'base64_encode', 'base64_decode',
      'url_encode', 'url_decode',
      'uuid', 'password',
      'hmac_sha256',
      'hex_encode', 'hex_decode',
      'random_bytes', 'jwt_decode'
    ]).describe('Crypto operation'),
    input: z.string().optional().describe('Input text/data'),
    key: z.string().optional().describe('Secret key for HMAC'),
    length: z.number().optional().default(32).describe('Length for password/random bytes generation')
  }),
  outputSchema: z.object({
    result: z.string(),
    success: z.boolean()
  }),
  execute: async (input: { operation: string, input?: string, key?: string, length?: number }) => {
    try {
      switch (input.operation) {
        case 'hash_md5':
          return { success: true, result: crypto.createHash('md5').update(input.input || '').digest('hex') };
        case 'hash_sha256':
          return { success: true, result: crypto.createHash('sha256').update(input.input || '').digest('hex') };
        case 'hash_sha512':
          return { success: true, result: crypto.createHash('sha512').update(input.input || '').digest('hex') };
        case 'base64_encode':
          return { success: true, result: Buffer.from(input.input || '').toString('base64') };
        case 'base64_decode':
          return { success: true, result: Buffer.from(input.input || '', 'base64').toString('utf-8') };
        case 'url_encode':
          return { success: true, result: encodeURIComponent(input.input || '') };
        case 'url_decode':
          return { success: true, result: decodeURIComponent(input.input || '') };
        case 'hex_encode':
          return { success: true, result: Buffer.from(input.input || '').toString('hex') };
        case 'hex_decode':
          return { success: true, result: Buffer.from(input.input || '', 'hex').toString('utf-8') };
        case 'uuid':
          return { success: true, result: crypto.randomUUID() };
        case 'password': {
          const len = Math.min(input.length || 32, 128);
          const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=[]{}|;:,.<>?';
          const bytes = crypto.randomBytes(len);
          let password = '';
          for (let i = 0; i < len; i++) {
            password += chars[bytes[i] % chars.length];
          }
          return { success: true, result: password, strength: len >= 20 ? 'strong' : len >= 12 ? 'medium' : 'weak' };
        }
        case 'hmac_sha256': {
          if (!input.key) return { success: false, result: 'key required for HMAC' };
          const hmac = crypto.createHmac('sha256', input.key).update(input.input || '').digest('hex');
          return { success: true, result: hmac };
        }
        case 'random_bytes': {
          const size = Math.min(input.length || 32, 256);
          return { success: true, result: crypto.randomBytes(size).toString('hex') };
        }
        case 'jwt_decode': {
          // Decode JWT without verification (useful for debugging)
          if (!input.input) return { success: false, result: 'JWT token required' };
          const parts = input.input.split('.');
          if (parts.length !== 3) return { success: false, result: 'Invalid JWT format (expected 3 parts)' };
          const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
          const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
          return { success: true, result: JSON.stringify({ header, payload }, null, 2), warning: 'Decoded without signature verification' };
        }
        default:
          return { success: false, result: 'Unknown operation' };
      }
    } catch (error: any) {
      return { success: false, result: `Crypto error: ${error.message}` };
    }
  }
};
