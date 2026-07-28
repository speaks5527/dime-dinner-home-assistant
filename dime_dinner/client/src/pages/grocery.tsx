import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  Eraser,
  FileSpreadsheet,
  Loader2,
  Package,
  Pencil,
  Plus,
  Printer,
  ShoppingCart,
  Store,
  Trash2,
  Undo2,
} from "lucide-react";
import { Layout, PageHeader } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  copyText,
  deleteJson,
  downloadFile,
  formatWeekRange,
  groceryToCsv,
  groceryToText,
  patchJson,
  postJson,
  printElement,
  shiftWeek,
  weekStartOf,
} from "@/lib/app";
import type { GroceryLine, GroceryResponse, KrogerMatchResponse, KrogerStatus } from "@shared/schema";

function KrogerPanel({ line }: { line: GroceryLine }) {
  const { data, isLoading, isError, error } = useQuery<KrogerMatchResponse>({
    queryKey: ["/api/kroger/match", line.name],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/kroger/match?term=${encodeURIComponent(line.name)}`);
      return (await res.json()) as KrogerMatchResponse;
    },
  });

  if (isLoading) return <Skeleton className="h-24 w-full" />;
  if (isError) {
    return (
      <p className="text-xs text-destructive" data-testid="text-kroger-error">
        {(error as Error).message.replace(/^\d+:\s*/, "")}
      </p>
    );
  }
  if (!data?.products.length) return <p className="text-xs text-muted-foreground">No matching products returned.</p>;

  return (
    <div className="space-y-3">
      {data.products.map((product) => (
        <div key={product.productId} className="flex gap-3" data-testid={`kroger-product-${product.productId}`}>
          {product.imageUrl ? (
            <img src={product.imageUrl} alt="" className="h-14 w-14 rounded object-contain" referrerPolicy="no-referrer" />
          ) : (
            <div className="surface-weave h-14 w-14 rounded bg-muted" />
          )}
          <div className="min-w-0 flex-1 text-xs">
            <p className="font-medium leading-snug">{product.description}</p>
            <p className="text-muted-foreground">
              {[product.brand, product.size].filter(Boolean).join(" · ")}
            </p>
            <p className="mt-0.5">
              {product.promoPrice != null && product.promoPrice !== product.regularPrice ? (
                <>
                  <span className="font-semibold text-primary">${product.promoPrice.toFixed(2)}</span>{" "}
                  <span className="text-muted-foreground line-through">${product.regularPrice?.toFixed(2)}</span>
                </>
              ) : product.regularPrice != null ? (
                <span className="font-semibold">${product.regularPrice.toFixed(2)}</span>
              ) : (
                <span className="text-muted-foreground">Price not returned</span>
              )}
            </p>
            <p className="mt-0.5 text-muted-foreground">
              {product.aisle ? `Aisle ${product.aisle}` : "Aisle not given"}
              {product.fulfillment.length ? ` · ${product.fulfillment.join(", ")}` : ""}
              {product.stockLevel ? ` · stock: ${product.stockLevel}` : ""}
            </p>
          </div>
        </div>
      ))}
      <p className="border-t border-border pt-2 text-[11px] leading-relaxed text-muted-foreground">{data.disclaimer}</p>
    </div>
  );
}

function LineRow({ line, weekStart, krogerOn }: { line: GroceryLine; weekStart: string; krogerOn: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(line.editedAmount ?? line.display);

  const mutateLine = useMutation({
    mutationFn: (payload: { path: string; body: unknown }) =>
      postJson<GroceryResponse>(`/api/grocery/${weekStart}/${payload.path}`, payload.body),
    onSuccess: (data) => queryClient.setQueryData(["/api/grocery", weekStart], data),
  });

  const pantry = line.pantry;

  return (
    <li className="flex items-start gap-3 py-2.5" data-testid={`row-grocery-${line.key}`}>
      <Checkbox
        checked={line.checked}
        onCheckedChange={(checked) => mutateLine.mutate({ path: "check", body: { itemKey: line.key, checked: !!checked } })}
        className="mt-0.5"
        aria-label={`Mark ${line.name} as bought`}
        data-testid={`checkbox-${line.key}`}
      />
      <div className="min-w-0 flex-1">
        <div className={`flex flex-wrap items-baseline gap-x-2 text-sm ${line.checked ? "text-muted-foreground line-through" : ""}`}>
          {editing ? (
            <form
              className="flex items-center gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                mutateLine.mutate({ path: "amount", body: { itemKey: line.key, amount: draft.trim() || null } });
                setEditing(false);
              }}
            >
              <Input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                className="h-7 w-28 text-xs"
                autoFocus
                data-testid={`input-amount-${line.key}`}
              />
              <Button type="submit" size="sm" className="h-7 px-2 text-xs" data-testid={`button-save-amount-${line.key}`}>
                Save
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => {
                  mutateLine.mutate({ path: "amount", body: { itemKey: line.key, amount: null } });
                  setEditing(false);
                }}
              >
                Reset
              </Button>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => {
                setDraft(line.editedAmount ?? line.display);
                setEditing(true);
              }}
              className="inline-flex items-center gap-1 font-medium hover:text-primary"
              data-testid={`button-edit-amount-${line.key}`}
            >
              {line.display || "—"} <Pencil className="h-3 w-3 opacity-50" />
            </button>
          )}
          <span data-testid={`text-name-${line.key}`}>{line.name}</span>
          {line.editedAmount && (
            <Badge variant="outline" className="text-[10px]">
              edited
            </Badge>
          )}
        </div>

        {pantry && (
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <Badge variant="secondary" className="gap-1 text-[10px]" data-testid={`badge-pantry-${line.key}`}>
              <Package className="h-3 w-3" />
              {pantry.status === "covered"
                ? `covered by pantry (${pantry.pantryDisplay})`
                : pantry.status === "reduced"
                  ? `reduced from ${pantry.originalDisplay} — pantry has ${pantry.pantryDisplay}`
                  : `pantry has ${pantry.pantryDisplay} — not deducted`}
            </Badge>
            {pantry.status !== "noted" && (
              <button
                type="button"
                className="inline-flex items-center gap-1 underline underline-offset-2"
                onClick={() =>
                  mutateLine.mutate({ path: "override", body: { itemKey: line.key, override: !pantry.overridden } })
                }
                data-testid={`button-override-${line.key}`}
              >
                <Undo2 className="h-3 w-3" />
                {pantry.overridden ? "use pantry stock" : "buy the full amount"}
              </button>
            )}
          </div>
        )}

        <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={line.sources.map((s) => `${s.recipe}: ${s.raw}`).join(" · ")}>
          {line.sources.map((s) => s.recipe).join(" · ")}
        </p>
      </div>

      {krogerOn && (
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-xs" data-testid={`button-kroger-${line.key}`}>
              <Store className="mr-1 h-3.5 w-3.5" /> Kroger
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80">
            <p className="mb-2 text-xs font-medium">Matches for “{line.name}”</p>
            <KrogerPanel line={line} />
          </PopoverContent>
        </Popover>
      )}
    </li>
  );
}

export default function GroceryPage() {
  const { toast } = useToast();
  const [weekStart, setWeekStart] = useState(weekStartOf());
  const [manualText, setManualText] = useState("");
  const grocery = useQuery<GroceryResponse>({ queryKey: ["/api/grocery", weekStart] });
  const settings = useQuery<{ kroger: KrogerStatus }>({ queryKey: ["/api/settings"] });

  const apply = (data: GroceryResponse) => queryClient.setQueryData(["/api/grocery", weekStart], data);

  const addManual = useMutation({
    mutationFn: (text: string) => postJson<GroceryResponse>(`/api/grocery/${weekStart}/manual`, { text }),
    onSuccess: (data) => {
      apply(data);
      setManualText("");
    },
  });
  const toggleManual = useMutation({
    mutationFn: (payload: { id: number; checked: boolean }) =>
      patchJson<GroceryResponse>(`/api/grocery/${weekStart}/manual/${payload.id}`, { checked: payload.checked }),
    onSuccess: apply,
  });
  const removeManual = useMutation({
    mutationFn: (id: number) => deleteJson<GroceryResponse>(`/api/grocery/${weekStart}/manual/${id}`),
    onSuccess: apply,
  });
  const clearChecks = useMutation({
    mutationFn: () => postJson<GroceryResponse>(`/api/grocery/${weekStart}/clear-checks`),
    onSuccess: apply,
  });
  const transfer = useMutation({
    mutationFn: () =>
      postJson<{ count: number; grocery: GroceryResponse }>("/api/pantry/transfer", {
        weekStart,
        includeManual: true,
        clearChecks: true,
      }),
    onSuccess: (data) => {
      apply(data.grocery);
      queryClient.invalidateQueries({ queryKey: ["/api/pantry"] });
      toast({
        title: data.count ? `Moved ${data.count} item${data.count === 1 ? "" : "s"} to the pantry` : "Nothing checked off yet",
        description: data.count ? "Checked items were added to your pantry and unchecked here." : undefined,
      });
    },
  });

  const data = grocery.data;
  const krogerOn = !!settings.data?.kroger.enabled && !!settings.data?.kroger.configured;
  const aisles = data ? Array.from(new Set(data.lines.map((line) => line.aisle))) : [];
  const checkedCount = (data?.lines.filter((l) => l.checked).length ?? 0) + (data?.manual.filter((m) => m.checked === 1).length ?? 0);
  const totalCount = (data?.lines.length ?? 0) + (data?.manual.length ?? 0);

  return (
    <Layout>
      <PageHeader
        title="Grocery list"
        subtitle={
          data
            ? `${totalCount} item${totalCount === 1 ? "" : "s"} from ${data.recipeCount} planned meal${data.recipeCount === 1 ? "" : "s"}${data.pantryCoveredCount ? ` · ${data.pantryCoveredCount} covered by pantry` : ""}`
            : undefined
        }
        actions={
          <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setWeekStart(shiftWeek(weekStart, -1))} aria-label="Previous week" data-testid="button-prev-week">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="px-2 text-sm font-medium" data-testid="text-week-range">
              {formatWeekRange(weekStart)}
            </span>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setWeekStart(shiftWeek(weekStart, 1))} aria-label="Next week" data-testid="button-next-week">
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        }
      />

      {/* Export */}
      <Card className="no-print mb-6 flex flex-col gap-3 border-card-border p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-medium">Export for Skylight</h2>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
            Copy a categorized plain-text list, or print/save a clean one-page PDF that Skylight&apos;s Magic Import can
            read from a photo or file. Everything happens on this device — Dime Dinner never signs in to Skylight.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={!data}
            onClick={async () => {
              const ok = await copyText(groceryToText(data!));
              toast({
                title: ok ? "List copied" : "Copy blocked by the browser",
                description: ok ? "Paste it anywhere you like." : "Use Print / PDF or CSV instead.",
                variant: ok ? undefined : "destructive",
              });
            }}
            data-testid="button-copy-list"
          >
            <ClipboardCopy className="mr-2 h-4 w-4" /> Copy text
          </Button>
          <Button variant="secondary" size="sm" onClick={() => printElement("grocery-print")} data-testid="button-print-list">
            <Printer className="mr-2 h-4 w-4" /> Print / PDF
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!data}
            onClick={() => downloadFile(`grocery-${weekStart}.csv`, groceryToCsv(data!), "text/csv;charset=utf-8")}
            data-testid="button-download-csv"
          >
            <FileSpreadsheet className="mr-2 h-4 w-4" /> CSV
          </Button>
        </div>
      </Card>

      {grocery.isLoading ? (
        <Skeleton className="h-80 w-full rounded-lg" />
      ) : !data || (data.lines.length === 0 && data.manual.length === 0) ? (
        <div className="surface-weave rounded-lg border border-dashed border-border p-10 text-center">
          <ShoppingCart className="mx-auto mb-2 h-6 w-6 text-muted-foreground" />
          <h2 className="font-display text-lg font-semibold">Nothing to buy yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            Plan a few meals for this week and their ingredients will show up here, combined and sorted by aisle.
          </p>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
          <div className="min-w-0">
            {aisles.map((aisle) => (
              <Card key={aisle} className="mb-4 border-card-border p-4" data-testid={`card-aisle-${aisle}`}>
                <h2 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{aisle}</h2>
                <ul className="divide-y divide-border">
                  {data.lines
                    .filter((line) => line.aisle === aisle)
                    .map((line) => (
                      <LineRow key={line.key} line={line} weekStart={weekStart} krogerOn={krogerOn} />
                    ))}
                </ul>
              </Card>
            ))}

            <Card className="border-card-border p-4">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Other items
              </h2>
              <ul className="divide-y divide-border">
                {data.manual.map((item) => (
                  <li key={item.id} className="flex items-center gap-3 py-2.5" data-testid={`row-manual-${item.id}`}>
                    <Checkbox
                      checked={item.checked === 1}
                      onCheckedChange={(checked) => toggleManual.mutate({ id: item.id, checked: !!checked })}
                      aria-label={`Mark ${item.text} as bought`}
                      data-testid={`checkbox-manual-${item.id}`}
                    />
                    <span className={`flex-1 text-sm ${item.checked === 1 ? "text-muted-foreground line-through" : ""}`}>
                      {item.text}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => removeManual.mutate(item.id)}
                      aria-label="Remove item"
                      data-testid={`button-remove-manual-${item.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
              <form
                className="mt-3 flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (manualText.trim()) addManual.mutate(manualText.trim());
                }}
              >
                <Input
                  value={manualText}
                  onChange={(event) => setManualText(event.target.value)}
                  placeholder="Add paper towels, coffee…"
                  data-testid="input-manual-item"
                />
                <Button type="submit" size="icon" aria-label="Add item" data-testid="button-add-manual">
                  {addManual.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                </Button>
              </form>
            </Card>
          </div>

          <div className="space-y-4">
            <Card className="border-card-border p-4">
              <h2 className="text-sm font-medium">Shopping progress</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {checkedCount} of {totalCount} checked off
              </p>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${totalCount ? (checkedCount / totalCount) * 100 : 0}%` }}
                  data-testid="progress-grocery"
                />
              </div>
              <div className="mt-4 space-y-2">
                <Button
                  className="w-full"
                  variant="secondary"
                  disabled={transfer.isPending}
                  onClick={() => transfer.mutate()}
                  data-testid="button-transfer-pantry"
                >
                  <Package className="mr-2 h-4 w-4" /> Move checked items to pantry
                </Button>
                <Button
                  className="w-full"
                  variant="ghost"
                  onClick={() => clearChecks.mutate()}
                  data-testid="button-clear-checks"
                >
                  <Eraser className="mr-2 h-4 w-4" /> Clear check marks
                </Button>
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
                Nothing moves into your pantry automatically — this button is the only way items get added from a shop.
              </p>
            </Card>
          </div>
        </div>
      )}

      {/* Hidden print layout */}
      <div id="grocery-print" className="hidden">
        <div style={{ fontFamily: "Georgia, serif" }}>
          <h1 style={{ fontSize: "20pt", margin: "0 0 2pt" }}>Grocery list</h1>
          <p style={{ fontSize: "11pt", margin: "0 0 14pt" }}>Week of {formatWeekRange(weekStart)}</p>
          <div style={{ columnCount: 2, columnGap: "24pt" }}>
            {aisles.map((aisle) => (
              <div key={aisle} style={{ breakInside: "avoid", marginBottom: "10pt" }}>
                <h2 style={{ fontSize: "11pt", margin: "0 0 3pt", textTransform: "uppercase" }}>{aisle}</h2>
                <ul style={{ margin: 0, paddingLeft: "16pt", fontSize: "11.5pt", lineHeight: 1.55 }}>
                  {(data?.lines ?? [])
                    .filter((line) => line.aisle === aisle)
                    .map((line) => (
                      <li key={line.key}>
                        {line.display} {line.name}
                      </li>
                    ))}
                </ul>
              </div>
            ))}
            {(data?.manual.length ?? 0) > 0 && (
              <div style={{ breakInside: "avoid", marginBottom: "10pt" }}>
                <h2 style={{ fontSize: "11pt", margin: "0 0 3pt", textTransform: "uppercase" }}>Other</h2>
                <ul style={{ margin: 0, paddingLeft: "16pt", fontSize: "11.5pt", lineHeight: 1.55 }}>
                  {(data?.manual ?? []).map((item) => (
                    <li key={item.id}>{item.text}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </div>
    </Layout>
  );
}
