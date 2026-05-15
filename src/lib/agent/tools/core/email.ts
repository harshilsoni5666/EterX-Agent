import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs-extra';

const execAsync = promisify(exec);

/**
 * Email Manager Tool
 * 
 * Sends emails via PowerShell's Send-MailMessage or via direct SMTP.
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
  execute: async (input: any) => {
    console.log(`[Tool: email_manager] Action: ${input.action}`);

    try {
      switch (input.action) {
        case 'send': {
          // Use PowerShell SMTP sending
          const smtpServer = process.env.SMTP_SERVER || 'smtp.gmail.com';
          const smtpPort = process.env.SMTP_PORT || '587';
          const smtpUser = process.env.SMTP_USER || process.env.EMAIL_ADDRESS;
          const smtpPass = process.env.SMTP_PASSWORD || process.env.GMAIL_APP_PASSWORD;

          if (!smtpUser || !smtpPass) {
            return { success: false, result: 'SMTP credentials not configured. Set SMTP_USER and SMTP_PASSWORD (or GMAIL_APP_PASSWORD) in .env.local' };
          }

          if (!input.to || !input.subject || !input.body) {
            return { success: false, result: 'Missing required fields: to, subject, body' };
          }

          const psScript = `
            $secpasswd = ConvertTo-SecureString '${(smtpPass).replace(/'/g, "''")}' -AsPlainText -Force;
            $credential = New-Object System.Management.Automation.PSCredential('${smtpUser}', $secpasswd);
            $params = @{
              From = '${smtpUser}'
              To = '${input.to}'
              Subject = '${(input.subject || '').replace(/'/g, "''")}'
              Body = '${(input.body || '').replace(/'/g, "''")}'
              SmtpServer = '${smtpServer}'
              Port = ${smtpPort}
              Credential = $credential
              UseSsl = $true
              ${input.body?.includes('<') ? "BodyAsHtml = $true" : ''}
            };
            ${input.cc ? `$params.Cc = '${input.cc}';` : ''}
            Send-MailMessage @params;
            Write-Output 'Email sent successfully.';
          `.trim();

          const { stdout } = await execAsync(psScript, { shell: 'powershell.exe' });
          return { success: true, result: stdout.trim() || 'Email sent successfully.' };
        }

        case 'draft': {
          const targetDir = path.resolve(process.cwd(), '.workspaces', 'temp', 'emails');
          await fs.ensureDir(targetDir);
          const draftFilename = input.filename || `draft_${Date.now()}.eml`;
          const draftPath = path.join(targetDir, draftFilename);

          const emlContent = [
            `From: ${process.env.EMAIL_ADDRESS || 'agent@eterx.local'}`,
            `To: ${input.to || 'recipient@example.com'}`,
            `Subject: ${input.subject || 'No Subject'}`,
            input.cc ? `Cc: ${input.cc}` : '',
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
          const targetDir = path.resolve(process.cwd(), '.workspaces', 'temp');
          const emlPath = path.resolve(targetDir, input.filename);
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
