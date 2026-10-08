import { spawn } from 'node:child_process';
import { NOTIFICATIONS_ENV } from '@tool/protocol';

export interface DialogChoice {
  decision: 'approved' | 'rejected';
  note?: string;
}

export interface DialogRequest {
  title: string;
  /** One line above the plan, e.g. the thread and gate. */
  heading: string;
  /** The exact plan text the agent submitted. */
  plan: string;
}

/**
 * Asks the developer to decide in a window on their desktop. `result` resolves with their choice,
 * or undefined if they chose "Later", closed it, or no window could be shown. The window only
 * reports which button was clicked; the bridge submits the decision itself, so the one-time code
 * and the member token never leave the bridge process. An agent cannot click it.
 */
export type ApprovalPrompt = (request: DialogRequest) => { result: Promise<DialogChoice | undefined>; close(): void };

// Text arrives through environment variables, never interpolated into the script, so plan
// content from an agent cannot inject anything. The choice is printed as one line of JSON.
const WINDOWS_FORM = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$form = New-Object System.Windows.Forms.Form
$form.Text = $env:TOOL_DIALOG_TITLE
$form.Size = New-Object System.Drawing.Size(720, 560)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.Font = New-Object System.Drawing.Font('Segoe UI', 10)

$plan = New-Object System.Windows.Forms.TextBox
$plan.Multiline = $true; $plan.ReadOnly = $true; $plan.ScrollBars = 'Vertical'; $plan.Dock = 'Fill'
$plan.Text = ($env:TOOL_DIALOG_PLAN -replace "\`r?\`n", "\`r\`n")

$heading = New-Object System.Windows.Forms.Label
$heading.Text = $env:TOOL_DIALOG_HEADING; $heading.Dock = 'Top'; $heading.Height = 48
$heading.Padding = New-Object System.Windows.Forms.Padding(8)

$noteLabel = New-Object System.Windows.Forms.Label
$noteLabel.Text = 'Note for the agent (optional: why, or what to change)'; $noteLabel.Dock = 'Bottom'; $noteLabel.Height = 26
$note = New-Object System.Windows.Forms.TextBox
$note.Dock = 'Bottom'

$buttons = New-Object System.Windows.Forms.FlowLayoutPanel
$buttons.Dock = 'Bottom'; $buttons.Height = 48; $buttons.FlowDirection = 'RightToLeft'; $buttons.Padding = New-Object System.Windows.Forms.Padding(6)
$script:choice = $null
foreach ($b in @(@('Approve', 'approved'), @('Reject', 'rejected'), @('Later', $null))) {
  $button = New-Object System.Windows.Forms.Button
  $button.Text = $b[0]; $button.Width = 110; $button.Height = 32; $button.Tag = $b[1]
  $button.Add_Click({ $script:choice = $this.Tag; $form.Close() })
  $buttons.Controls.Add($button)
}

# Docking is applied in reverse order of adding, so the fill control goes first.
$form.Controls.Add($plan)
$form.Controls.Add($heading)
$form.Controls.Add($noteLabel)
$form.Controls.Add($note)
$form.Controls.Add($buttons)
$form.Add_Shown({ $form.Activate() })
[void]$form.ShowDialog()

if ($script:choice) { [Console]::Out.Write((@{ decision = $script:choice; note = $note.Text } | ConvertTo-Json -Compress)) }
`;

// macOS: a plain dialog. The answer comes back as "button returned:X, text returned:Y".
const MAC_DIALOG = `
set answer to display dialog (system attribute "TOOL_DIALOG_HEADING") & return & return & (system attribute "TOOL_DIALOG_PLAN") ¬
  with title (system attribute "TOOL_DIALOG_TITLE") default answer "" ¬
  buttons {"Later", "Reject", "Approve"} default button "Approve"
return (button returned of answer) & linefeed & (text returned of answer)
`;

/** The desktop window on Windows and macOS. Undefined elsewhere, or with notifications off. */
export function desktopApprovalPrompt(): ApprovalPrompt | undefined {
  if (process.env[NOTIFICATIONS_ENV] === 'off') return undefined;
  if (process.platform !== 'win32' && process.platform !== 'darwin') return undefined;

  return (request) => {
    const env = { ...process.env, TOOL_DIALOG_TITLE: request.title, TOOL_DIALOG_HEADING: request.heading, TOOL_DIALOG_PLAN: request.plan };
    // The process must not start hidden, or Windows hides the window too; PowerShell hides its own console.
    const child =
      process.platform === 'win32'
        ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', WINDOWS_FORM], { env, windowsHide: false })
        : spawn('osascript', ['-e', MAC_DIALOG], { env });

    const result = new Promise<DialogChoice | undefined>((resolve) => {
      let out = '';
      child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
      child.on('error', () => resolve(undefined));
      child.on('close', () => resolve(parseChoice(out)));
    });
    return { result, close: () => child.kill() };
  };
}

export function parseChoice(output: string): DialogChoice | undefined {
  const text = output.trim();
  if (!text) return undefined;
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as { decision?: string; note?: string };
      if (parsed.decision !== 'approved' && parsed.decision !== 'rejected') return undefined;
      return { decision: parsed.decision, ...(parsed.note?.trim() && { note: parsed.note.trim() }) };
    } catch {
      return undefined;
    }
  }
  // macOS: "<button>\n<note>"
  const [button, ...rest] = text.split('\n');
  const note = rest.join('\n').trim();
  const decision = button === 'Approve' ? 'approved' : button === 'Reject' ? 'rejected' : undefined;
  return decision && { decision, ...(note && { note }) };
}
