# Third-party notices

## Provider marks (lobe-icons)

The model provider marks in `client/src/lib/providerMarks.ts` (Claude, OpenAI, Gemini, DeepSeek, Zhipu, Kimi, Qwen, Meta and MCP) reuse SVG path data from **lobe-icons**.

- Package: `@lobehub/icons-static-svg` **1.102.0**, the plain mono variants (`icons/<name>.svg`).
- Source: https://github.com/lobehub/lobe-icons
- Licence: MIT, as declared in the package manifest (author: LobeHub). The npm tarball ships no separate LICENSE file; the text below is the standard MIT text with the manifest author as holder.

Only the path strings are vendored (no package dependency). The marks are drawn in `currentColor`.

```
MIT License

Copyright (c) LobeHub

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The marks themselves remain trademarks of their owners (Anthropic, OpenAI, Google, DeepSeek, Zhipu AI, Moonshot AI, Alibaba, Meta, and the Model Context Protocol project). They identify models and imply no affiliation or endorsement.
