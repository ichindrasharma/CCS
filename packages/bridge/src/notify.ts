import { spawn } from 'node:child_process';

export interface Notice {
  title: string;
  message: string;
}

/**
 * Reaches the developer outside the agent. Approval codes travel only through this channel,
 * never through a tool result, a file or stderr, because the agent can read all of those.
 */
export interface Notifier {
  notify(notice: Notice): void;
}

// Text is passed through environment variables, never interpolated into a command, so message
// content from another developer cannot inject anything.
const WINDOWS_TOAST = `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$text = $template.GetElementsByTagName('text')
$text.Item(0).AppendChild($template.CreateTextNode($env:TOOL_NOTICE_TITLE)) > $null
$text.Item(1).AppendChild($template.CreateTextNode($env:TOOL_NOTICE_MESSAGE)) > $null
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($template))
`;

const MAC_NOTICE = 'display notification (system attribute "TOOL_NOTICE_MESSAGE") with title (system attribute "TOOL_NOTICE_TITLE") sound name "default"';

/** Desktop notification on Windows, macOS and Linux; falls back to the terminal bell. */
export function desktopNotifier(): Notifier {
  return {
    notify({ title, message }) {
      const env = { ...process.env, TOOL_NOTICE_TITLE: title, TOOL_NOTICE_MESSAGE: message };
      const [command, args] =
        process.platform === 'win32'
          ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_TOAST]]
          : process.platform === 'darwin'
            ? ['osascript', ['-e', MAC_NOTICE]]
            : ['notify-send', [title, message]];
      try {
        const child = spawn(command, args as string[], { env, stdio: 'ignore', windowsHide: true });
        child.on('error', ringBell);
        child.on('exit', (code) => code !== 0 && ringBell());
        child.unref();
      } catch {
        ringBell();
      }
    },
  };
}

/** No desktop session (e.g. SSH): ring the bell without the content. */
function ringBell(): void {
  process.stderr.write('\x07');
}
