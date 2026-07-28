import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Package, Pencil, Plus, Trash2 } from "lucide-react";
import { Layout, PageHeader } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { deleteJson, patchJson, postJson } from "@/lib/app";
import type { PantryItem } from "@shared/schema";

function PantryRow({ item }: { item: PantryItem }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(item.name);
  const [quantity, setQuantity] = useState(item.quantity == null ? "" : String(item.quantity));
  const [unit, setUnit] = useState(item.unit ?? "");

  const save = useMutation({
    mutationFn: () =>
      patchJson(`/api/pantry/${item.id}`, {
        name: name.trim(),
        quantity: quantity.trim() === "" ? null : Number(quantity),
        unit: unit.trim() || null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/pantry"] });
      queryClient.invalidateQueries({ queryKey: ["/api/grocery"] });
      setEditing(false);
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteJson(`/api/pantry/${item.id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/pantry"] });
      queryClient.invalidateQueries({ queryKey: ["/api/grocery"] });
    },
  });

  if (editing) {
    return (
      <li className="py-2.5" data-testid={`row-pantry-${item.id}`}>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8 min-w-[10rem] flex-1 text-sm" data-testid={`input-pantry-name-${item.id}`} />
          <Input value={quantity} onChange={(e) => setQuantity(e.target.value)} inputMode="decimal" placeholder="qty" className="h-8 w-20 text-sm" data-testid={`input-pantry-qty-${item.id}`} />
          <Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="unit" className="h-8 w-24 text-sm" data-testid={`input-pantry-unit-${item.id}`} />
          <Button type="submit" size="sm" className="h-8" data-testid={`button-save-pantry-${item.id}`}>
            Save
          </Button>
          <Button type="button" size="sm" variant="ghost" className="h-8" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </form>
      </li>
    );
  }

  return (
    <li className="flex items-center gap-3 py-2.5" data-testid={`row-pantry-${item.id}`}>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium" data-testid={`text-pantry-name-${item.id}`}>
          {item.name}
        </p>
        <p className="text-xs text-muted-foreground">
          {item.quantity != null ? `${item.quantity}${item.unit ? ` ${item.unit}` : ""}` : "quantity not tracked"}
          {item.note ? ` · ${item.note}` : ""}
        </p>
      </div>
      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setEditing(true)} aria-label="Edit item" data-testid={`button-edit-pantry-${item.id}`}>
        <Pencil className="h-3.5 w-3.5" />
      </Button>
      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => remove.mutate()} aria-label="Remove item" data-testid={`button-delete-pantry-${item.id}`}>
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </li>
  );
}

export default function PantryPage() {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("");
  const { data: items = [], isLoading } = useQuery<PantryItem[]>({ queryKey: ["/api/pantry"] });

  const add = useMutation({
    mutationFn: () =>
      postJson("/api/pantry", {
        name: name.trim(),
        quantity: quantity.trim() === "" ? null : Number(quantity),
        unit: unit.trim() || null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/pantry"] });
      queryClient.invalidateQueries({ queryKey: ["/api/grocery"] });
      setName("");
      setQuantity("");
      setUnit("");
      toast({ title: "Added to pantry" });
    },
  });

  return (
    <Layout>
      <PageHeader
        title="Pantry"
        subtitle="What you already have at home. The grocery list deducts from it conservatively and always shows its work."
      />

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Card className="border-card-border p-4">
          <form
            className="mb-4 flex flex-wrap gap-2 border-b border-border pb-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim()) add.mutate();
            }}
          >
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Olive oil, rice, taco seasoning…"
              className="min-w-[12rem] flex-1"
              data-testid="input-pantry-new-name"
            />
            <Input
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              inputMode="decimal"
              placeholder="qty"
              className="w-20"
              data-testid="input-pantry-new-qty"
            />
            <Input
              value={unit}
              onChange={(event) => setUnit(event.target.value)}
              placeholder="unit"
              className="w-24"
              data-testid="input-pantry-new-unit"
            />
            <Button type="submit" disabled={!name.trim() || add.isPending} data-testid="button-add-pantry">
              <Plus className="mr-2 h-4 w-4" /> Add
            </Button>
          </form>

          {isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : items.length === 0 ? (
            <div className="surface-weave rounded-md border border-dashed border-border p-8 text-center">
              <Package className="mx-auto mb-2 h-6 w-6 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                Your pantry is empty. Add the staples you keep on hand — quantity is optional.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border" data-testid="list-pantry">
              {items.map((item) => (
                <PantryRow key={item.id} item={item} />
              ))}
            </ul>
          )}
        </Card>

        <Card className="h-fit border-card-border bg-muted/40 p-4">
          <h2 className="font-display text-sm font-semibold">How deductions work</h2>
          <ul className="mt-2 space-y-2 text-xs leading-relaxed text-muted-foreground">
            <li>
              <strong className="text-foreground">Same kind of unit → deducted.</strong> 8 fl oz of milk in the pantry
              takes 1 cup off a 2-cup requirement, and the list shows the original amount.
            </li>
            <li>
              <strong className="text-foreground">Different unit → only noted.</strong> Pounds of flour against cups of
              flour is not converted, so nothing is deducted and you decide.
            </li>
            <li>
              <strong className="text-foreground">No quantity → shelf staples only.</strong> An untracked entry can
              cover spices and dry goods, never fresh meat or produce.
            </li>
            <li>
              <strong className="text-foreground">Always reversible.</strong> Every deducted line has a “buy the full
              amount” override on the grocery list.
            </li>
          </ul>
        </Card>
      </div>
    </Layout>
  );
}
