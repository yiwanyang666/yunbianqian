import { CheckCircle2, AlertCircle, Info, AlertTriangle, X } from 'lucide-react';
import type { ToastItem } from '../types';

interface ToastContainerProps {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}

export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none px-4 sm:px-0">
      {toasts.map((t) => {
        const iconMap = {
          success: <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />,
          error: <AlertCircle className="w-4 h-4 text-rose-500 shrink-0" />,
          warning: <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />,
          info: <Info className="w-4 h-4 text-teal-500 shrink-0" />,
        };
        return (
          <div
            key={t.id}
            className="pointer-events-auto animate-fade-in-up flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl bg-white/95 dark:bg-zinc-900/95 backdrop-blur-md border border-zinc-200/80 dark:border-zinc-800 shadow-lg shadow-black/5 dark:shadow-black/40 text-sm text-zinc-800 dark:text-zinc-100"
          >
            {iconMap[t.type]}
            <span className="flex-1 leading-snug">{t.message}</span>
            <button
              type="button"
              onClick={() => onDismiss(t.id)}
              className="p-0.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors"
              aria-label="关闭提示"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
