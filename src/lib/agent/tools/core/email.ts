import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import path from 'path';
import fs from 'fs-extra';
import {
  resolveFinalArtifactPathForContext,
  resolveReadableWorkspacePathForContext,
} from '../../workspace/path_resolver';
import { enforceToolCapability } from '../security/tool_policy';

function cleanHeader(value: unknown): string {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

function parseSmtpPort(value: string | undefined): number {
  const port = Number.parseInt(value || '587', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid SMTP_PORT. Expected a TCP port between 1 and 65535.');
  }
  return port;
}

/**
 * Email Manager Tool
 * 
 * Sends emails via direct SMTP.
 * Reads email drafts by composing mailto: links or reading local mailbox exports.
 * For full Gmail IMAP, configure GMAIL_APP_PASSWORD in .env.local
 */
export const emailTool: ToolDefinition = {
  name: 'email_manager',
  description: 'Send emails, draft email content, or compose mailto links. For sending, uses SMTP with configured credentials. Can also read email drafts saved as .eml files in workspace.',
  category: 'core',
  inputSchema: z.object({
    action: z.enum(['send', 'draft', 'compose_link', 'read_eml']).describe('Action: send (SMTP), draft (save to file), compose_link (mailto URL), read_eml (parse .eml file)'),
    to: z.string().optional().describe('Recipient email address (required for send/draft/compose)'),
    subject: z.string().optional().describe('Email subject line'),
    body: z.string().optional().describe('Email body content (supports HTML for send)'),
    cc: z.string().optional().describe('CC recipients (comma-separated)'),
    attachments: z.string().optional().describe('Comma-separated file paths to attach'),
    filename: z.string().optional().describe('For read_eml: the .eml file to parse; for draft: output filename')
  }),
  outputSchema: z.object({
    success: z.boolean(),
    result: z.string()
  }),
  execute: async (input: any, context?: any) => {
    console.log(`[Tool: email_manager] Action: ${input.action}`);

    try {
      const decision = enforceToolCapability('email_manager', input, context);
      if (!decision.allowed) {
        return { success: false, result: decision.reason || 'Email access is not allowed' };
      }

      switch (input.action) {
        case 'send': {
          const smtpServer = cleanHeader(process.env.SMTP_SERVER || 'smtp.gmail.com');
          const smtpPort = parseSmtpPort(process.env.SMTP_PORT);
          const smtpUser = cleanHeader(process.env.SMTP_USER || process.env.EMAIL_ADDRESS);
          const smtpPass = process.env.SMTP_PASSWORD || process.env.GMAIL_APP_PASSWORD;

          if (!smtpUser || !smtpPass) {
            return { success: false, result: 'SMTP credentials not configured. Set SMTP_USER and SMTP_PASSWORD (or GMAIL_APP_PASSWORD) in .env.local' };
          }

          if (!input.to || !input.subject || !input.body) {
            return { success: false, result: 'Missing required fields: to, subject, body' };
          }

          const nodemailer = require('nodemailer');
          const transporter = nodemailer.createTransport({
            host: smtpServer,
            port: smtpPort,
            secure: smtpPort === 465,
            auth: { user: smtpUser, pass: smtpPass },
          });
          const body = String(input.body || '');
          const info = await transporter.sendMail({
            from: smtpUser,
            to: cleanHeader(input.to),
            cc: input.cc ? cleanHeader(input.cc) : undefined,
            subject: cleanHeader(input.subject),
            ...(body.includes('<') ? { html: body } : { text: body }),
          });
          return { success: true, result: `Email sent successfully (${info.messageId || 'SMTP accepted'}).` };
        }

        case 'draft': {
          const draftFilename = input.filename || `draft_${Date.now()}.eml`;
          const draftPath = resolveFinalArtifactPathForContext(draftFilename, '.eml', input.subject || 'Email Draft', context);
          await fs.ensureDir(path.dirname(draftPath));

          const emlContent = [
            `From: ${cleanHeader(process.env.EMAIL_ADDRESS || 'agent@eterx.local')}`,
            `To: ${cleanHeader(input.to || 'recipient@example.com')}`,
            `Subject: ${cleanHeader(input.subject || 'No Subject')}`,
            input.cc ? `Cc: ${cleanHeader(input.cc)}` : '',
            `Date: ${new Date().toUTCString()}`,
            `MIME-Version: 1.0`,
            `Content-Type: text/plain; charset=UTF-8`,
            '',
            input.body || ''
          ].filter(Boolean).join('\r\n');

          await fs.writeFile(draftPath, emlContent, 'utf-8');
          return { success: true, result: `Draft saved to: ${draftPath}` };
        }

        case 'compose_link': {
          const params = new URLSearchParams();
          if (input.subject) params.set('subject', input.subject);
          if (input.body) params.set('body', input.body);
          if (input.cc) params.set('cc', input.cc);
          const mailto = `mailto:${input.to || ''}?${params.toString()}`;
          return { success: true, result: `Mailto link: ${mailto}` };
        }

        case 'read_eml': {
          if (!input.filename) return { success: false, result: 'filename required for read_eml' };
          const emlPath = resolveReadableWorkspacePathForContext(input.filename, context);
          if (!await fs.pathExists(emlPath)) {
            return { success: false, result: `File not found: ${input.filename}` };
          }
          const content = await fs.readFile(emlPath, 'utf-8');
          return { success: true, result: content.substring(0, 10000) };
        }

        default:
          return { success: false, result: 'Unknown action' };
      }
    } catch (error: any) {
      return { success: false, result: `Email operation failed: ${error.message}` };
    }
  }
};
