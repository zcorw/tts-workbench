import { createContext, useContext, useRef, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Link } from 'react-router-dom';
import { messageOf, type Services } from '../types';
export const ServiceContext = createContext<{
  services: Services;
  notify: (m: string) => void;
  failed: (e: unknown) => void;
}>(null!);
export const useServices = () => useContext(ServiceContext);
export function useAction() {
  const { failed } = useServices();
  const mutation = useMutation({
    mutationFn: (fn: () => Promise<void>) => fn(),
    retry: false,
    onError: failed,
  });
  return {
    busy: mutation.isPending,
    error: mutation.error ? messageOf(mutation.error) : '',
    setError: () => mutation.reset(),
    async run(fn: () => Promise<void>) {
      try {
        await mutation.mutateAsync(fn);
      } catch {}
    },
  };
}
export function ErrorNotice({ message, id }: { message: string; id?: string }) {
  return (
    <p id={id} className="inline-error" role="alert" hidden={!message}>
      {message}
    </p>
  );
}
export function Modal({
  title,
  id,
  children,
  onClose,
  busy = false,
  kicker = '',
}: {
  title: string;
  id: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  kicker?: string;
}) {
  const previous = useRef(document.activeElement as HTMLElement | null);
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          id={id}
          className="modal-dialog"
          aria-describedby={undefined}
          onEscapeKeyDown={(e) => {
            if (busy) e.preventDefault();
          }}
          onInteractOutside={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            previous.current?.focus();
          }}
        >
          <div className="dialog-heading">
            <div>
              {kicker && <span className="eyebrow">{kicker}</span>}
              <Dialog.Title asChild>
                <h2>{title}</h2>
              </Dialog.Title>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="icon-button" aria-label="关闭" disabled={busy}>
                ×
              </button>
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Brand() {
  return (
    <Link className="brand" to="/workbench" aria-label="YOMI 首页">
      <span className="brand-mark">よ</span>
      <span>
        YOMI<small>日文语音工作台</small>
      </span>
    </Link>
  );
}
export function PageHeading({
  kicker,
  title,
  children,
  action,
}: {
  kicker: string;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{kicker}</div>
        <h1>
          {title}
          <span>。</span>
        </h1>
        <p>{children}</p>
      </div>
      {action}
    </div>
  );
}
