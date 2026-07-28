import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Minus,
  Plus,
  Search,
  ShoppingCart,
  SkipForward,
  Undo2,
  X,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { deleteJson, patchJson, postJson } from "@/lib/app";
import type {
  KrogerCartModality,
  KrogerCartResult,
  KrogerProduct,
  KrogerReview,
  KrogerReviewItem,
} from "@shared/schema";

const MAX_QUANTITY = 99;

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function priceOf(product: KrogerProduct): number | null {
  const price = product.promoPrice ?? product.regularPrice;
  return price != null && price > 0 ? Math.round(price * 100) : null;
}

function clean(error: Error): string {
  return error.message.replace(/^\d+:\s*/, "");
}

function selected(item: KrogerReviewItem): KrogerProduct | null {
  return item.candidates.find((c) => c.upc === item.selectedUpc) ?? null;
}

/* ------------------------------ product bits ------------------------------ */

function ProductThumb({ product }: { product: KrogerProduct | null }) {
  if (product?.imageUrl) {
    return (
      <img
        src={product.imageUrl}
        alt=""
        className="h-14 w-14 shrink-0 rounded border border-border bg-white object-contain"
        referrerPolicy="no-referrer"
        loading="lazy"
      />
    );
  }
  return (
    <div className="surface-weave flex h-14 w-14 shrink-0 items-center justify-center rounded border border-border bg-muted">
      <ShoppingCart className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
    </div>
  );
}

function PriceTag({ product }: { product: KrogerProduct }) {
  const cents = priceOf(product);
  if (cents == null) return <span className="text-muted-foreground">Price not returned</span>;
  const promo = product.promoPrice != null && product.promoPrice !== product.regularPrice;
  return promo ? (
    <>
      <span className="font-semibold text-primary">{money(cents)}</span>{" "}
      <span className="text-muted-foreground line-through">
        {product.regularPrice != null ? money(Math.round(product.regularPrice * 100)) : ""}
      </span>
    </>
  ) : (
    <span className="font-semibold">{money(cents)}</span>
  );
}

/* -------------------------------- one item -------------------------------- */

function ItemRow({
  item,
  onPatch,
  onSearch,
  busy,
}: {
  item: KrogerReviewItem;
  onPatch: (patch: Record<string, unknown>) => void;
  onSearch: (term: string) => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState(item.name);
  const product = selected(item);
  const skipped = item.status === "skipped";
  const needsChoice = !skipped && !product;

  const setQuantity = (next: number) => {
    const clamped = Math.max(1, Math.min(MAX_QUANTITY, Math.round(next)));
    if (clamped !== item.quantity) onPatch({ quantity: clamped });
  };

  return (
    <li
      className={`rounded-lg border p-3 ${
        skipped
          ? "border-dashed border-border bg-muted/30"
          : needsChoice
            ? "border-amber-500/50 bg-amber-500/5"
            : "border-border"
      }`}
      data-testid={`cart-item-${item.key}`}
    >
      <div className="flex items-start gap-3">
        <ProductThumb product={product} />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-medium" data-testid={`cart-item-name-${item.key}`}>
              {item.name}
            </span>
            {item.requestedDisplay && (
              <span className="text-[11px] text-muted-foreground">recipe needs {item.requestedDisplay}</span>
            )}
            {skipped && (
              <Badge variant="secondary" className="text-[10px]">
                skipped
              </Badge>
            )}
            {needsChoice && (
              <Badge variant="outline" className="border-amber-500/60 text-[10px] text-amber-700 dark:text-amber-300">
                {item.candidates.length ? "pick a product" : "no match found"}
              </Badge>
            )}
          </div>

          {product ? (
            <div className="mt-0.5 text-xs">
              <p className="leading-snug" data-testid={`cart-item-product-${item.key}`}>
                {product.description}
              </p>
              <p className="text-muted-foreground">{[product.brand, product.size].filter(Boolean).join(" · ")}</p>
              <p className="mt-0.5">
                <PriceTag product={product} />
              </p>
            </div>
          ) : (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {item.candidates.length
                ? "Nothing was close enough to choose for you. Pick one below or skip this item."
                : "Kroger returned no product for this. Search for it below, or skip it and buy it in the store."}
            </p>
          )}

          {!skipped && product && (
            <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="flex items-center gap-1">
                <span className="text-[11px] text-muted-foreground">Qty</span>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => setQuantity(item.quantity - 1)}
                  disabled={busy || item.quantity <= 1}
                  aria-label={`One fewer ${item.name}`}
                  data-testid={`button-qty-down-${item.key}`}
                >
                  <Minus className="h-3 w-3" />
                </Button>
                <Input
                  type="number"
                  min={1}
                  max={MAX_QUANTITY}
                  step={1}
                  value={item.quantity}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    if (Number.isFinite(next)) setQuantity(next);
                  }}
                  className="h-7 w-14 text-center text-xs"
                  aria-label={`Quantity of ${item.name}`}
                  data-testid={`input-qty-${item.key}`}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => setQuantity(item.quantity + 1)}
                  disabled={busy || item.quantity >= MAX_QUANTITY}
                  aria-label={`One more ${item.name}`}
                  data-testid={`button-qty-up-${item.key}`}
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </div>

              {item.availableModalities.length > 1 && (
                <div
                  className="flex items-center gap-1 rounded-md border border-border p-0.5"
                  role="group"
                  aria-label={`How to get ${item.name}`}
                >
                  {item.availableModalities.map((modality) => (
                    <Button
                      key={modality}
                      type="button"
                      variant={item.modality === modality ? "secondary" : "ghost"}
                      size="sm"
                      className="h-6 px-2 text-[11px] capitalize"
                      aria-pressed={item.modality === modality}
                      onClick={() => onPatch({ modality })}
                      disabled={busy}
                      data-testid={`button-modality-${modality.toLowerCase()}-${item.key}`}
                    >
                      {modality.toLowerCase()}
                    </Button>
                  ))}
                </div>
              )}

              <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
                <Checkbox
                  checked={item.allowSubstitutes}
                  onCheckedChange={(checked) => onPatch({ allowSubstitutes: !!checked })}
                  disabled={busy}
                  data-testid={`checkbox-substitutes-${item.key}`}
                />
                Allow substitutes
              </label>
            </div>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-2">
            {!skipped && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px]"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                data-testid={`button-alternatives-${item.key}`}
              >
                {open ? "Hide options" : product ? "Choose a different product" : "Choose a product"}
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => onPatch({ skipped: !skipped })}
              disabled={busy}
              data-testid={`button-skip-${item.key}`}
            >
              {skipped ? (
                <>
                  <Undo2 className="mr-1 h-3 w-3" /> Put back
                </>
              ) : (
                <>
                  <SkipForward className="mr-1 h-3 w-3" /> Skip this item
                </>
              )}
            </Button>
          </div>
        </div>
      </div>

      {open && !skipped && (
        <div className="mt-3 border-t border-border pt-3">
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (term.trim()) onSearch(term.trim());
            }}
          >
            <Input
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Search Kroger for something else"
              className="h-8 text-xs"
              maxLength={60}
              aria-label={`Search Kroger products for ${item.name}`}
              data-testid={`input-search-${item.key}`}
            />
            <Button type="submit" size="sm" variant="secondary" className="h-8" disabled={busy} data-testid={`button-search-${item.key}`}>
              <Search className="h-3.5 w-3.5" />
              <span className="sr-only">Search</span>
            </Button>
          </form>

          <ul className="mt-2 space-y-1" role="radiogroup" aria-label={`Products for ${item.name}`}>
            {item.candidates.map((candidate) => {
              const active = candidate.upc === item.selectedUpc;
              return (
                <li key={candidate.upc || candidate.productId}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={`flex w-full items-center gap-2.5 rounded-md border p-2 text-left transition-colors ${
                      active ? "border-primary bg-primary/5" : "border-transparent hover:bg-muted"
                    }`}
                    onClick={() => onPatch({ selectedUpc: active ? null : candidate.upc })}
                    disabled={busy || !candidate.upc}
                    data-testid={`button-candidate-${item.key}-${candidate.upc}`}
                  >
                    <ProductThumb product={candidate} />
                    <span className="min-w-0 flex-1 text-xs">
                      <span className="block leading-snug">{candidate.description}</span>
                      <span className="block text-muted-foreground">
                        {[candidate.brand, candidate.size].filter(Boolean).join(" · ")}
                      </span>
                      <span className="mt-0.5 block">
                        <PriceTag product={candidate} />
                        {!candidate.upc && <span className="ml-2 text-muted-foreground">cannot be added</span>}
                      </span>
                    </span>
                    {active && <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />}
                  </button>
                </li>
              );
            })}
            {!item.candidates.length && (
              <li className="px-2 py-1 text-xs text-muted-foreground">No products to choose from yet.</li>
            )}
          </ul>
        </div>
      )}
    </li>
  );
}

/* ------------------------------- the dialog ------------------------------- */

type Step = "review" | "confirm" | "results";

export function KrogerCartDialog({
  weekStart,
  open,
  onOpenChange,
}: {
  weekStart: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const [review, setReview] = useState<KrogerReview | null>(null);
  const [step, setStep] = useState<Step>("review");
  const [result, setResult] = useState<KrogerCartResult | null>(null);

  const build = useMutation({
    mutationFn: () => postJson<KrogerReview>("/api/kroger/cart/review", { weekStart }),
    onSuccess: (data) => {
      setReview(data);
      setStep("review");
      setResult(null);
    },
    onError: (error: Error) => {
      toast({ title: "Could not build a cart", description: clean(error), variant: "destructive" });
      onOpenChange(false);
    },
  });

  // Nothing is looked up at Kroger until the dialog is actually opened, and only
  // once per opening.
  const requested = useRef(false);
  useEffect(() => {
    if (!open) {
      requested.current = false;
      return;
    }
    if (!requested.current) {
      requested.current = true;
      build.mutate();
    }
  }, [open]);

  const patch = useMutation({
    mutationFn: (input: { key: string; patch: Record<string, unknown> }) =>
      patchJson<KrogerReview>(`/api/kroger/cart/review/${review!.id}/items/${encodeURIComponent(input.key)}`, input.patch),
    onSuccess: setReview,
    onError: (error: Error) => toast({ title: "Could not update that item", description: clean(error), variant: "destructive" }),
  });

  const search = useMutation({
    mutationFn: (input: { key: string; term: string }) =>
      postJson<KrogerReview>(
        `/api/kroger/cart/review/${review!.id}/items/${encodeURIComponent(input.key)}/search`,
        { term: input.term },
      ),
    onSuccess: setReview,
    onError: (error: Error) => toast({ title: "Search failed", description: clean(error), variant: "destructive" }),
  });

  const confirm = useMutation({
    mutationFn: () =>
      postJson<KrogerCartResult>(`/api/kroger/cart/review/${review!.id}/confirm`, {
        confirm: true,
        itemCount: review!.readyCount,
      }),
    onSuccess: (data) => {
      setResult(data);
      setStep("results");
      queryClient.invalidateQueries({ queryKey: ["/api/kroger/auth/status"] });
    },
    onError: (error: Error) => {
      toast({ title: "Nothing was added", description: clean(error), variant: "destructive" });
      setStep("review");
    },
  });

  const discard = useMutation({
    mutationFn: (id: string) => deleteJson(`/api/kroger/cart/review/${id}`),
  });

  const close = () => {
    // The review holds Kroger product data, so it is dropped rather than left to
    // time out on the server.
    if (review && step !== "results") discard.mutate(review.id);
    setReview(null);
    setResult(null);
    setStep("review");
    build.reset();
    onOpenChange(false);
  };

  const busy = patch.isPending || search.isPending || confirm.isPending;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="flex max-h-[92vh] w-[calc(100vw-1.5rem)] max-w-2xl flex-col gap-0 overflow-hidden p-0 sm:w-full">
        <DialogHeader className="border-b border-border p-4 text-left sm:p-5">
          <DialogTitle className="flex items-center gap-2 font-display">
            <ShoppingCart className="h-4 w-4 text-primary" />
            {step === "results" ? "What went into your cart" : step === "confirm" ? "Confirm before adding" : "Review your Kroger cart"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {step === "results"
              ? "Only the items Kroger confirmed are in your cart."
              : step === "confirm"
                ? "Nothing has been added yet. This is the last step before Dime Dinner writes to your Kroger cart."
                : `Everything still unchecked on this list, matched to Kroger products.${review?.locationName ? ` Store: ${review.locationName}.` : ""}`}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
          {build.isPending && (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">Looking each item up at Kroger…</p>
            </div>
          )}

          {step === "review" && review && (
            <>
              {review.needsAttentionCount > 0 && (
                <p
                  className="mb-3 flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs leading-relaxed text-amber-900 dark:text-amber-200"
                  data-testid="text-cart-attention"
                >
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>
                    {review.needsAttentionCount} item{review.needsAttentionCount === 1 ? "" : "s"} need
                    {review.needsAttentionCount === 1 ? "s" : ""} a decision. Dime Dinner will not guess — choose a
                    product or skip it.
                  </span>
                </p>
              )}
              {review.notices.map((notice) => (
                <p key={notice} className="mb-2 text-[11px] text-muted-foreground">
                  {notice}
                </p>
              ))}
              <ul className="space-y-2.5">
                {review.items.map((item) => (
                  <ItemRow
                    key={item.key}
                    item={item}
                    busy={busy}
                    onPatch={(p) => patch.mutate({ key: item.key, patch: p })}
                    onSearch={(term) => search.mutate({ key: item.key, term })}
                  />
                ))}
              </ul>
              <p className="mt-4 border-t border-border pt-3 text-[11px] leading-relaxed text-muted-foreground">
                {review.disclaimer}
              </p>
            </>
          )}

          {step === "confirm" && review && (
            <div className="space-y-4">
              <div className="rounded-lg border border-border p-4">
                <p className="text-sm">
                  Add{" "}
                  <strong data-testid="text-confirm-count">
                    {review.readyCount} product{review.readyCount === 1 ? "" : "s"}
                  </strong>{" "}
                  to your Kroger cart
                  {review.locationName ? ` at ${review.locationName}` : ""}.
                </p>
                <p className="mt-2 text-sm">
                  Estimated subtotal{" "}
                  <strong data-testid="text-confirm-subtotal">{money(review.estimatedSubtotalCents)}</strong>
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  This is an estimate only — it uses the prices Kroger reported just now, before taxes, fees, weight
                  differences on items sold by weight, and any promotions applied at checkout. Kroger&apos;s cart is
                  what counts.
                  {review.estimateIncomplete && " Some items reported no price, so they are missing from this total."}
                </p>
              </div>

              <ul className="space-y-1 text-xs">
                {review.items
                  .filter((item) => item.status !== "skipped" && selected(item))
                  .map((item) => (
                    <li key={item.key} className="flex justify-between gap-3 border-b border-border py-1.5 last:border-0">
                      <span className="min-w-0">
                        <span className="block truncate">{selected(item)!.description}</span>
                        <span className="text-muted-foreground">
                          {item.quantity} × {item.modality.toLowerCase()}
                          {!item.allowSubstitutes && " · no substitutes"}
                        </span>
                      </span>
                      <span className="shrink-0 tabular-nums">
                        {priceOf(selected(item)!) != null ? money(priceOf(selected(item)!)! * item.quantity) : "—"}
                      </span>
                    </li>
                  ))}
              </ul>

              {review.items.some((item) => item.status === "skipped") && (
                <p className="text-[11px] text-muted-foreground">
                  Skipped, and not added:{" "}
                  {review.items
                    .filter((item) => item.status === "skipped")
                    .map((item) => item.name)
                    .join(", ")}
                </p>
              )}
            </div>
          )}

          {step === "results" && result && (
            <div className="space-y-3">
              <p className="text-sm" data-testid="text-cart-result-summary">
                <strong>
                  {result.addedCount} item{result.addedCount === 1 ? "" : "s"}
                </strong>{" "}
                confirmed by Kroger
                {result.failedCount > 0 ? `, ${result.failedCount} not added.` : "."}
              </p>

              {result.authExpired && (
                <p className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>Your Kroger sign-in expired part-way through. Reconnect in Settings, then try the rest again.</span>
                </p>
              )}

              <ul className="space-y-1.5">
                {result.results.map((row) => (
                  <li
                    key={row.key}
                    className="flex items-start gap-2 rounded-md border border-border p-2.5 text-xs"
                    data-testid={`cart-result-${row.key}`}
                  >
                    {row.ok ? (
                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                    ) : (
                      <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden="true" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{row.name}</span>
                      <span className="text-muted-foreground">
                        {" "}
                        — {row.quantity} × {row.modality.toLowerCase()}
                      </span>
                      {!row.ok && row.error && <span className="block text-destructive">{row.error}</span>}
                    </span>
                  </li>
                ))}
              </ul>

              {result.noSubstitutionReminders.length > 0 && (
                <p className="rounded-md border border-border bg-muted/50 p-2.5 text-[11px] leading-relaxed text-muted-foreground">
                  Kroger&apos;s cart API cannot carry a no-substitutions flag, so set it yourself at checkout for:{" "}
                  <strong>{result.noSubstitutionReminders.join(", ")}</strong>.
                </p>
              )}

              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Nothing is ordered until you check out at Kroger, where you pick your time slot and confirm the total.
              </p>
            </div>
          )}
        </div>

        <DialogFooter className="flex-row items-center gap-2 border-t border-border bg-muted/30 p-4 sm:p-5">
          {step === "review" && review && (
            <>
              <div className="mr-auto text-xs text-muted-foreground" data-testid="text-cart-ready">
                {review.readyCount} ready
                {review.needsAttentionCount > 0 ? ` · ${review.needsAttentionCount} need attention` : ""}
                {review.readyCount > 0 && (
                  <>
                    {" · about "}
                    <span className="tabular-nums">{money(review.estimatedSubtotalCents)}</span>
                    <span className="ml-1">(estimate)</span>
                  </>
                )}
              </div>
              <Button type="button" variant="ghost" onClick={close} data-testid="button-cancel-cart">
                <X className="mr-2 h-4 w-4" /> Cancel
              </Button>
              <Button
                type="button"
                onClick={() => setStep("confirm")}
                disabled={busy || review.readyCount === 0 || review.needsAttentionCount > 0}
                data-testid="button-continue-cart"
              >
                Continue
              </Button>
            </>
          )}

          {step === "confirm" && review && (
            <>
              <Button type="button" variant="ghost" className="mr-auto" onClick={() => setStep("review")} data-testid="button-back-cart">
                <ArrowLeft className="mr-2 h-4 w-4" /> Back to review
              </Button>
              <Button type="button" variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button type="button" onClick={() => confirm.mutate()} disabled={confirm.isPending} data-testid="button-confirm-cart">
                {confirm.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <ShoppingCart className="mr-2 h-4 w-4" />
                )}
                Add {review.readyCount} item{review.readyCount === 1 ? "" : "s"} to my cart
              </Button>
            </>
          )}

          {step === "results" && result && (
            <>
              <Button type="button" variant="ghost" className="mr-auto" onClick={close} data-testid="button-close-cart">
                Done
              </Button>
              <Button asChild disabled={result.addedCount === 0}>
                <a href={result.cartUrl} target="_blank" rel="noopener noreferrer" data-testid="link-kroger-cart">
                  <ExternalLink className="mr-2 h-4 w-4" /> Open Kroger cart
                </a>
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
