import { useState, type ReactNode, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/**
 * A small form-in-a-dialog used by the "New X" buttons across the app.
 *
 * It exists so that customers, vendors, items and the rest don't each
 * re-implement the same open/submit/pending/error/toast/close dance. The caller
 * supplies the fields and an async `onSubmit`; this owns the lifecycle:
 *
 *   - disables the form while submitting,
 *   - turns a thrown error into an inline message (server validation surfaces
 *     here rather than vanishing),
 *   - closes and toasts on success.
 *
 * `onSubmit` returning normally means success. Throwing means failure, and the
 * thrown message is shown — so server functions that throw `LedgerError` give
 * the user the real reason, not a generic "something went wrong".
 */
export function EntityFormDialog({
  trigger,
  title,
  description,
  submitLabel = "Save",
  successMessage,
  onSubmit,
  children,
}: {
  trigger: ReactNode;
  title: string;
  description?: string;
  submitLabel?: string;
  successMessage: string;
  /** Perform the write. Throw to surface an error and keep the dialog open. */
  onSubmit: () => Promise<void>;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await onSubmit();
      setOpen(false);
      toast.success(successMessage);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </DialogHeader>

          <div className="grid gap-4 py-4">{children}</div>

          {error ? (
            <p role="alert" className="mb-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Saving…
                </>
              ) : (
                submitLabel
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
