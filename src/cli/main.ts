#!/usr/bin/env bun
import { run } from './run.ts'

const code = await run(process.argv.slice(2), {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
  promptYesNo: async (question) => {
    process.stderr.write(`${question} `)
    for await (const chunk of Bun.stdin.stream()) {
      const text = new TextDecoder().decode(chunk)
      return text.trim().toLowerCase().startsWith('y')
    }
    return false
  },
})
process.exit(code)
