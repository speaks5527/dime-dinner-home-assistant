import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Download, Heart, Loader2, Search, Trash2, Link2 } from "lucide-react";
import { Layout, PageHeader } from "@/components/Layout";
import { RecipeImage, RecipeMeta } from "@/components/RecipeBits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { deleteJson, patchJson, postJson } from "@/lib/app";
import type { RecipeDTO, SearchResponse } from "@shared/schema";

function SavedCard({ recipe }: { recipe: RecipeDTO }) {
  const { toast } = useToast();
  const favorite = useMutation({
    mutationFn: () => patchJson<RecipeDTO>(`/api/recipes/${recipe.id}`, { favorite: !recipe.favorite }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/recipes"] }),
  });
  const remove = useMutation({
    mutationFn: () => deleteJson(`/api/recipes/${recipe.id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/recipes"] });
      toast({ title: "Recipe removed" });
    },
  });

  return (
    <Card className="group overflow-hidden border-card-border" data-testid={`card-recipe-${recipe.id}`}>
      <Link href={`/recipes/${recipe.id}`}>
        <RecipeImage src={recipe.imageUrl} alt={recipe.title} className="h-40 w-full" testId={`img-recipe-${recipe.id}`} />
      </Link>
      <div className="space-y-2.5 p-4">
        <div className="flex items-start justify-between gap-2">
          <Link
            href={`/recipes/${recipe.id}`}
            className="font-display text-base font-semibold leading-snug hover:text-primary"
            data-testid={`link-recipe-${recipe.id}`}
          >
            {recipe.title}
          </Link>
          <Button
            variant="ghost"
            size="icon"
            className="-mr-2 -mt-1 h-8 w-8 shrink-0"
            onClick={() => favorite.mutate()}
            aria-label={recipe.favorite ? "Remove from favorites" : "Add to favorites"}
            data-testid={`button-favorite-${recipe.id}`}
          >
            <Heart className={`h-4 w-4 ${recipe.favorite ? "fill-primary text-primary" : "text-muted-foreground"}`} />
          </Button>
        </div>
        <RecipeMeta recipe={recipe} />
        <div className="flex items-center justify-between pt-1">
          <span className="truncate text-[11px] text-muted-foreground">{recipe.siteName ?? "imported"}</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={() => remove.mutate()}
            data-testid={`button-delete-${recipe.id}`}
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" /> Remove
          </Button>
        </div>
      </div>
    </Card>
  );
}

export default function RecipesPage() {
  const { toast } = useToast();
  const [term, setTerm] = useState("");
  const [query, setQuery] = useState("");
  const [importUrl, setImportUrl] = useState("");
  const [tab, setTab] = useState("library");

  const saved = useQuery<RecipeDTO[]>({ queryKey: ["/api/recipes"] });
  const search = useQuery<SearchResponse>({
    queryKey: ["/api/search", query],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/search?q=${encodeURIComponent(query)}`);
      return (await res.json()) as SearchResponse;
    },
    enabled: tab === "browse",
  });

  const importRecipe = useMutation({
    mutationFn: (url: string) => postJson<{ recipe: RecipeDTO; notice?: string }>("/api/import", { url }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/recipes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/search"] });
      setImportUrl("");
      toast({ title: `Saved “${data.recipe.title}”`, description: data.notice });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not import that link",
        description: error.message.replace(/^\d+:\s*/, "").replace(/^\{"message":"|"\}$/g, ""),
        variant: "destructive",
      });
    },
  });

  const recipes = saved.data ?? [];
  const favorites = recipes.filter((r) => r.favorite);

  return (
    <Layout>
      <PageHeader
        title="Recipes"
        subtitle="Browse Eating on a Dime, or import any recipe page that publishes standard recipe data."
      />

      {/* Import bar */}
      <Card className="mb-6 border-card-border p-4">
        <label htmlFor="import-url" className="mb-2 flex items-center gap-2 text-sm font-medium">
          <Link2 className="h-4 w-4 text-primary" /> Import recipe URL
        </label>
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            if (importUrl.trim()) importRecipe.mutate(importUrl.trim());
          }}
        >
          <Input
            id="import-url"
            value={importUrl}
            onChange={(event) => setImportUrl(event.target.value)}
            placeholder="https://www.eatingonadime.com/crockpot-chicken-and-noodles/"
            inputMode="url"
            data-testid="input-import-url"
          />
          <Button type="submit" disabled={importRecipe.isPending || !importUrl.trim()} data-testid="button-import">
            {importRecipe.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
            Import
          </Button>
        </form>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Works with any public recipe page that publishes schema.org Recipe data — that includes Eating on a Dime and
          most major recipe sites. Pages behind logins, paywalls or private networks are not fetched.
        </p>
      </Card>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-5">
          <TabsTrigger value="library" data-testid="tab-library">
            My library {recipes.length ? `(${recipes.length})` : ""}
          </TabsTrigger>
          <TabsTrigger value="browse" data-testid="tab-browse">
            Browse Eating on a Dime
          </TabsTrigger>
        </TabsList>

        <TabsContent value="library">
          {saved.isLoading ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-64 w-full rounded-lg" />
              ))}
            </div>
          ) : recipes.length === 0 ? (
            <div className="surface-weave rounded-lg border border-dashed border-border p-10 text-center">
              <h2 className="font-display text-lg font-semibold">Your recipe box is empty</h2>
              <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
                Paste a recipe link above, or switch to Browse to search the Eating on a Dime catalog.
              </p>
              <Button className="mt-4" onClick={() => setTab("browse")} data-testid="button-empty-browse">
                <Search className="mr-2 h-4 w-4" /> Browse recipes
              </Button>
            </div>
          ) : (
            <>
              {favorites.length > 0 && (
                <div className="mb-7">
                  <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Favorites
                  </h2>
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {favorites.map((recipe) => (
                      <SavedCard key={recipe.id} recipe={recipe} />
                    ))}
                  </div>
                </div>
              )}
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                All recipes
              </h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {recipes.map((recipe) => (
                  <SavedCard key={recipe.id} recipe={recipe} />
                ))}
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent value="browse">
          <form
            className="mb-5 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setQuery(term.trim());
            }}
          >
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={term}
                onChange={(event) => setTerm(event.target.value)}
                placeholder="Search chicken, casserole, crockpot…"
                className="pl-9"
                data-testid="input-search"
              />
            </div>
            <Button type="submit" data-testid="button-search">
              Search
            </Button>
          </form>

          {search.data?.source === "demo" && (
            <div className="mb-4 rounded-md border border-border bg-muted/60 p-3 text-xs text-muted-foreground">
              {search.data.notice ?? "Showing the offline demo catalog."}
            </div>
          )}

          {search.isFetching ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-52 w-full rounded-lg" />
              ))}
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {(search.data?.results ?? []).map((hit) => (
                <Card key={hit.url} className="flex flex-col overflow-hidden border-card-border" data-testid={`card-hit-${hit.url}`}>
                  <RecipeImage src={hit.imageUrl} alt={hit.title} className="h-36 w-full" />
                  <div className="flex flex-1 flex-col gap-2 p-4">
                    <h3 className="font-display text-sm font-semibold leading-snug">{hit.title}</h3>
                    {hit.excerpt && <p className="line-clamp-3 text-xs text-muted-foreground">{hit.excerpt}</p>}
                    <div className="mt-auto flex items-center gap-2 pt-2">
                      {hit.savedId ? (
                        <Link href={`/recipes/${hit.savedId}`}>
                          <Badge variant="secondary" data-testid={`badge-saved-${hit.savedId}`}>
                            In your library
                          </Badge>
                        </Link>
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={importRecipe.isPending}
                          onClick={() => importRecipe.mutate(hit.url)}
                          data-testid="button-import-hit"
                        >
                          <Download className="mr-1.5 h-3.5 w-3.5" /> Save
                        </Button>
                      )}
                      <a
                        href={hit.url}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="text-xs text-muted-foreground underline underline-offset-2"
                      >
                        View source
                      </a>
                    </div>
                  </div>
                </Card>
              ))}
              {!search.isFetching && (search.data?.results.length ?? 0) === 0 && (
                <p className="text-sm text-muted-foreground">No recipes matched that search.</p>
              )}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </Layout>
  );
}
