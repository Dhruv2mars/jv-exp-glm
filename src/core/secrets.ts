// High-confidence secret patterns scanned in captured traces. The adapter
// owns real sanitization; this pass is the fail-closed backstop that keeps
// obvious credentials out of permanent World history. Matching is line
// based so the error can point at the evidence.

const PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'AWS access key', regex: /AKIA[0-9A-Z]{16}/ },
  { name: 'GitHub token', regex: /gh[pousr]_[A-Za-z0-9]{36}/ },
  { name: 'GitHub fine-grained token', regex: /github_pat_[A-Za-z0-9_]{22,}/ },
  { name: 'OpenAI-style key', regex: /sk-[A-Za-z0-9_-]{20,}/ },
  { name: 'Anthropic key', regex: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'Slack token', regex: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'npm token', regex: /npm_[A-Za-z0-9]{36}/ },
  { name: 'private key block', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
]

export interface SecretFinding {
  name: string
  line: number
}

export function scanTraceForSecrets(bytes: Uint8Array): SecretFinding[] {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return [] // binary traces are not line-scannable; adapters sanitize them
  }
  const findings: SecretFinding[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    for (const pattern of PATTERNS) {
      if (pattern.regex.test(lines[i]!)) {
        findings.push({ name: pattern.name, line: i + 1 })
      }
    }
  }
  return findings
}
