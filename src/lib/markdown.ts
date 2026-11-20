import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({
  gfm: true,
  breaks: true,
});

export function renderSafeMarkdown(content: string): string {
  if (!content.trim()) {
    return '<p class="text-zinc-400 italic">暂无内容，切换到编辑模式开始书写…</p>';
  }
  const raw = marked.parse(content, { async: false }) as string;
  return DOMPurify.sanitize(raw);
}
