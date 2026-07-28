import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CalendarDays, ChefHat, ChevronLeft, ChevronRight, Download, Plus, Printer, Trash2, X } from "lucide-react";
import { Layout, PageHeader } from "@/components/Layout";
import { RecipeImage } from "@/components/RecipeBits";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { API_BASE, queryClient } from "@/lib/queryClient";
import { DAYS, dayDate, deleteJson, formatMinutes, formatWeekRange, postJson, shiftWeek, printElement, weekStartOf } from "@/lib/app";
import type { GroceryResponse, PlanEntry, PlanResponse, RecipeDTO } from "@shared/schema";

const MEALS = ["lunch", "dinner"] as const;

function PickRecipeDialog({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onPick: (recipeId: number) => void;
}) {
  const [term, setTerm] = useState("");
  const { data: recipes = [], isLoading } = useQuery<RecipeDTO[]>({ queryKey: ["/api/recipes"] });
  const filtered = recipes.filter((r) => r.title.toLowerCase().includes(term.toLowerCase()));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-hidden" data-testid="dialog-pick-recipe">
        <DialogHeader>
          <DialogTitle className="font-display">Choose a recipe</DialogTitle>
          <DialogDescription>Pick from your saved library.</DialogDescription>
        </DialogHeader>
        <Input
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder="Filter recipes…"
          data-testid="input-pick-filter"
        />
        <div className="-mx-1 max-h-[45vh] overflow-y-auto px-1">
          {isLoading && <Skeleton className="h-24 w-full" />}
          {!isLoading && recipes.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No saved recipes yet.{" "}
              <Link href="/" className="text-primary underline underline-offset-2">
                Import one first
              </Link>
              .
            </p>
          )}
          <ul className="space-y-1">
            {filtered.map((recipe) => (
              <li key={recipe.id}>
                <button
                  type="button"
                  onClick={() => onPick(recipe.id)}
                  className="flex w-full items-center gap-3 rounded-md p-2 text-left hover-elevate"
                  data-testid={`button-pick-${recipe.id}`}
                >
                  <RecipeImage src={recipe.imageUrl} alt="" className="h-11 w-11 shrink-0 rounded-md" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{recipe.title}</span>
                    <span className="block text-xs text-muted-foreground">
                      {formatMinutes(recipe.totalMinutes) ?? "—"} · {recipe.ingredients.length} ingredients
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SlotCard({
  entry,
  weekStart,
  day,
  meal,
  onAdd,
}: {
  entry?: PlanEntry;
  weekStart: string;
  day: number;
  meal: string;
  onAdd: () => void;
}) {
  const clear = useMutation({
    mutationFn: () => deleteJson<PlanResponse>(`/api/plan/${weekStart}/${day}/${meal}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/plan", weekStart] });
      queryClient.invalidateQueries({ queryKey: ["/api/grocery", weekStart] });
    },
  });

  if (!entry) {
    return (
      <button
        type="button"
        onClick={onAdd}
        className="flex h-full min-h-[74px] w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border text-xs text-muted-foreground hover-elevate"
        data-testid={`button-add-slot-${day}-${meal}`}
      >
        <Plus className="h-3.5 w-3.5" /> Add {meal}
      </button>
    );
  }

  return (
    <div className="group relative flex h-full min-h-[74px] gap-2.5 rounded-md border border-card-border bg-card p-2" data-testid={`slot-${day}-${meal}`}>
      <RecipeImage src={entry.recipe.imageUrl} alt="" className="h-12 w-12 shrink-0 rounded" />
      <div className="min-w-0 flex-1">
        <Link
          href={`/recipes/${entry.recipe.id}`}
          className="line-clamp-2 text-xs font-medium leading-snug hover:text-primary"
          data-testid={`link-slot-recipe-${entry.recipe.id}`}
        >
          {entry.recipe.title}
        </Link>
        <div className="mt-1 flex items-center gap-1">
          <Link href={`/cook/${entry.recipe.id}`}>
            <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px]" data-testid={`button-cook-slot-${day}-${meal}`}>
              <ChefHat className="mr-1 h-3 w-3" /> Cook
            </Button>
          </Link>
        </div>
      </div>
      <button
        type="button"
        onClick={() => clear.mutate()}
        aria-label="Remove meal"
        className="absolute right-1 top-1 rounded p-1 text-muted-foreground opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100"
        data-testid={`button-clear-slot-${day}-${meal}`}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export default function PlannerPage() {
  const { toast } = useToast();
  const [weekStart, setWeekStart] = useState(weekStartOf());
  const [picking, setPicking] = useState<{ day: number; meal: string } | null>(null);

  const plan = useQuery<PlanResponse>({ queryKey: ["/api/plan", weekStart] });
  const grocery = useQuery<GroceryResponse>({ queryKey: ["/api/grocery", weekStart] });
  const settings = useQuery<{ mealTimes: { lunch: string; dinner: string; timezone: string } }>({
    queryKey: ["/api/settings"],
  });

  const setSlot = useMutation({
    mutationFn: (recipeId: number) =>
      postJson<PlanResponse>(`/api/plan/${weekStart}`, { day: picking!.day, meal: picking!.meal, recipeId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/plan", weekStart] });
      queryClient.invalidateQueries({ queryKey: ["/api/grocery", weekStart] });
      setPicking(null);
    },
  });

  const clearWeek = useMutation({
    mutationFn: () => postJson(`/api/plan/${weekStart}/clear`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/plan", weekStart] });
      queryClient.invalidateQueries({ queryKey: ["/api/grocery", weekStart] });
      toast({ title: "Week cleared" });
    },
  });

  const entries = plan.data?.entries ?? [];
  const entryFor = (day: number, meal: string) => entries.find((e) => e.day === day && e.meal === meal);
  const times = settings.data?.mealTimes ?? { lunch: "12:00", dinner: "18:00", timezone: "local" };

  return (
    <Layout>
      <PageHeader
        title="Weekly planner"
        subtitle="Two slots a day. The grocery list rebuilds itself from whatever is planned."
        actions={
          <>
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
            {weekStart !== weekStartOf() && (
              <Button variant="ghost" size="sm" onClick={() => setWeekStart(weekStartOf())} data-testid="button-this-week">
                This week
              </Button>
            )}
          </>
        }
      />

      {/* Export bar */}
      <Card className="no-print mb-6 flex flex-col gap-3 border-card-border p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-medium">Export week for Skylight</h2>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
            Print or save a one-page plan for Skylight&apos;s Magic Import (photo or PDF), or download an .ics file to
            add the meals to a calendar. Dime Dinner does not connect to your Skylight account — nothing syncs
            automatically.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => printElement("week-print")} data-testid="button-print-week">
            <Printer className="mr-2 h-4 w-4" /> Print / PDF
          </Button>
          <a href={`${API_BASE}/api/plan/${weekStart}/calendar.ics`} download data-testid="link-download-ics">
            <Button variant="secondary" size="sm">
              <Download className="mr-2 h-4 w-4" /> .ics calendar
            </Button>
          </a>
          <Button variant="ghost" size="sm" onClick={() => clearWeek.mutate()} data-testid="button-clear-week">
            <Trash2 className="mr-2 h-4 w-4" /> Clear week
          </Button>
        </div>
      </Card>

      {plan.isLoading ? (
        <Skeleton className="h-96 w-full rounded-lg" />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {DAYS.map((name, day) => {
            const date = dayDate(weekStart, day);
            const isToday = date.toDateString() === new Date().toDateString();
            return (
              <Card
                key={name}
                className={`border-card-border p-3 ${isToday ? "ring-1 ring-primary/40" : ""}`}
                data-testid={`card-day-${day}`}
              >
                <div className="mb-2.5 flex items-baseline justify-between">
                  <h2 className="font-display text-sm font-semibold">{name}</h2>
                  <span className={`text-xs ${isToday ? "font-semibold text-primary" : "text-muted-foreground"}`}>
                    {date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  </span>
                </div>
                <div className="space-y-2">
                  {MEALS.map((meal) => (
                    <div key={meal}>
                      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {meal}
                      </p>
                      <SlotCard
                        entry={entryFor(day, meal)}
                        weekStart={weekStart}
                        day={day}
                        meal={meal}
                        onAdd={() => setPicking({ day, meal })}
                      />
                    </div>
                  ))}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {entries.length === 0 && !plan.isLoading && (
        <div className="surface-weave mt-6 rounded-lg border border-dashed border-border p-8 text-center">
          <CalendarDays className="mx-auto mb-2 h-6 w-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            Nothing planned yet. Tap a slot to drop in a recipe from your library.
          </p>
        </div>
      )}

      <PickRecipeDialog
        open={picking !== null}
        onOpenChange={(open) => !open && setPicking(null)}
        onPick={(recipeId) => setSlot.mutate(recipeId)}
      />

      {/* Hidden print layout: week plan (page 1) + grocery list (page 2) */}
      <div id="week-print" className="hidden">
        <div style={{ fontFamily: "Georgia, serif" }}>
          <h1 style={{ fontSize: "20pt", margin: "0 0 2pt" }}>Meal plan</h1>
          <p style={{ fontSize: "11pt", margin: "0 0 14pt" }}>
            Week of {formatWeekRange(weekStart)} · lunch {times.lunch} · dinner {times.dinner}
          </p>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11pt" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", borderBottom: "1px solid #999", padding: "5pt 4pt", width: "22%" }}>Day</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #999", padding: "5pt 4pt" }}>Lunch</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #999", padding: "5pt 4pt" }}>Dinner</th>
              </tr>
            </thead>
            <tbody>
              {DAYS.map((name, day) => (
                <tr key={name}>
                  <td style={{ borderBottom: "1px solid #ddd", padding: "7pt 4pt", verticalAlign: "top" }}>
                    <strong>{name}</strong>
                    <br />
                    <span style={{ fontSize: "9pt" }}>
                      {dayDate(weekStart, day).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    </span>
                  </td>
                  {MEALS.map((meal) => {
                    const entry = entryFor(day, meal);
                    return (
                      <td key={meal} style={{ borderBottom: "1px solid #ddd", padding: "7pt 4pt", verticalAlign: "top" }}>
                        {entry ? entry.recipe.title : "—"}
                        {entry?.recipe.siteName ? (
                          <span style={{ display: "block", fontSize: "8.5pt" }}>{entry.recipe.siteName}</span>
                        ) : null}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ fontSize: "8.5pt", marginTop: "12pt" }}>
            Generated by Dime Dinner. Recipes belong to their publishers.
          </p>

          {grocery.data && grocery.data.lines.length > 0 && (
            <div style={{ breakBefore: "page", pageBreakBefore: "always", paddingTop: "10pt" }}>
              <h1 style={{ fontSize: "20pt", margin: "0 0 10pt" }}>Grocery list</h1>
              {Array.from(new Set(grocery.data.lines.map((l) => l.aisle))).map((aisle) => (
                <div key={aisle} style={{ marginBottom: "10pt" }}>
                  <h2 style={{ fontSize: "11pt", margin: "0 0 3pt", textTransform: "uppercase" }}>{aisle}</h2>
                  <ul style={{ margin: 0, paddingLeft: "16pt", fontSize: "11pt", lineHeight: 1.5 }}>
                    {grocery.data!.lines
                      .filter((line) => line.aisle === aisle)
                      .map((line) => (
                        <li key={line.key}>
                          {line.display} {line.name}
                        </li>
                      ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}
