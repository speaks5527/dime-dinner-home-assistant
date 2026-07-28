import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Info, Loader2, Store } from "lucide-react";
import { Layout, PageHeader } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { postJson } from "@/lib/app";
import type { KrogerStatus } from "@shared/schema";

type SettingsResponse = {
  kroger: KrogerStatus;
  mealTimes: { lunch: string; dinner: string; timezone: string };
};

export default function SettingsPage() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<SettingsResponse>({ queryKey: ["/api/settings"] });
  const { data: meta } = useQuery<{ attribution: string }>({ queryKey: ["/api/meta"] });

  const [enabled, setEnabled] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [zip, setZip] = useState("");
  const [locationId, setLocationId] = useState("");
  const [lunch, setLunch] = useState("12:00");
  const [dinner, setDinner] = useState("18:00");
  const [timezone, setTimezone] = useState("");

  useEffect(() => {
    if (!data) return;
    setEnabled(data.kroger.enabled);
    setClientId(data.kroger.clientId);
    setZip(data.kroger.zip);
    setLocationId(data.kroger.locationId);
    setLunch(data.mealTimes.lunch);
    setDinner(data.mealTimes.dinner);
    setTimezone(data.mealTimes.timezone);
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      postJson("/api/settings", {
        kroger: { enabled, clientId, clientSecret, zip, locationId },
        mealTimes: { lunch, dinner, timezone },
      }),
    onSuccess: () => {
      setClientSecret("");
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({ title: "Settings saved" });
    },
    onError: (error: Error) => toast({ title: "Could not save", description: error.message, variant: "destructive" }),
  });

  const test = useMutation({
    mutationFn: () => postJson<{ message: string }>("/api/kroger/test"),
    onSuccess: (result) => toast({ title: "Kroger connection", description: result.message }),
    onError: (error: Error) =>
      toast({
        title: "Kroger connection failed",
        description: error.message.replace(/^\d+:\s*/, ""),
        variant: "destructive",
      }),
  });

  const clear = useMutation({
    mutationFn: () => postJson("/api/settings/kroger/clear"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({ title: "Kroger credentials cleared" });
    },
  });

  const managed = data?.kroger.managedByAddonOptions;

  return (
    <Layout>
      <PageHeader title="Settings" subtitle="Meal times, optional store lookups, and what this add-on does with data." />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="border-card-border p-5">
          <h2 className="font-display text-base font-semibold">Meal times</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Used for exported calendar events. Times are written in your chosen time zone.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="lunch">Lunch</Label>
              <Input id="lunch" type="time" value={lunch} onChange={(e) => setLunch(e.target.value)} data-testid="input-lunch-time" />
            </div>
            <div>
              <Label htmlFor="dinner">Dinner</Label>
              <Input id="dinner" type="time" value={dinner} onChange={(e) => setDinner(e.target.value)} data-testid="input-dinner-time" />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="timezone">Time zone</Label>
              <Input
                id="timezone"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                placeholder="America/New_York"
                data-testid="input-timezone"
              />
              <button
                type="button"
                className="mt-1 text-[11px] text-primary underline underline-offset-2"
                onClick={() => setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone)}
                data-testid="button-detect-timezone"
              >
                Use this device&apos;s time zone
              </button>
            </div>
          </div>
        </Card>

        <Card className="border-card-border p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="flex items-center gap-2 font-display text-base font-semibold">
                <Store className="h-4 w-4 text-primary" /> Kroger lookups
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Optional. With Kroger developer credentials, each grocery line gets an on-demand product match with
                price, aisle and fulfillment options. Everything else works without this.
              </p>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enable Kroger lookups" data-testid="switch-kroger" />
          </div>

          {managed && (
            <p className="mt-3 rounded-md border border-border bg-muted/60 p-2.5 text-[11px] text-muted-foreground">
              These values are currently supplied by the add-on configuration in Home Assistant. Changes made here are
              overridden by the add-on options.
            </p>
          )}

          <div className="mt-4 space-y-3">
            <div>
              <Label htmlFor="client-id">Client ID</Label>
              <Input id="client-id" value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" data-testid="input-kroger-client-id" />
            </div>
            <div>
              <Label htmlFor="client-secret">Client secret</Label>
              <Input
                id="client-secret"
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder={data?.kroger.hasClientSecret ? "•••••••• saved — type to replace" : "Client secret"}
                autoComplete="new-password"
                data-testid="input-kroger-secret"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="zip">ZIP code</Label>
                <Input id="zip" value={zip} onChange={(e) => setZip(e.target.value)} inputMode="numeric" placeholder="40202" data-testid="input-kroger-zip" />
              </div>
              <div>
                <Label htmlFor="location-id">Location ID (optional)</Label>
                <Input id="location-id" value={locationId} onChange={(e) => setLocationId(e.target.value)} placeholder="01400943" data-testid="input-kroger-location" />
              </div>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => test.mutate()} disabled={test.isPending} data-testid="button-test-kroger">
              {test.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
              Test connection
            </Button>
            <Button variant="ghost" size="sm" onClick={() => clear.mutate()} data-testid="button-clear-kroger">
              Clear credentials
            </Button>
          </div>
          {!isLoading && data && (
            <p className="mt-3 text-xs text-muted-foreground" data-testid="text-kroger-status">
              {data.kroger.message}
            </p>
          )}
        </Card>
      </div>

      <div className="mt-4">
        <Button onClick={() => save.mutate()} disabled={save.isPending} data-testid="button-save-settings">
          {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save settings
        </Button>
      </div>

      <Card className="mt-6 border-card-border bg-muted/40 p-5">
        <h2 className="flex items-center gap-2 font-display text-base font-semibold">
          <Info className="h-4 w-4" /> About Dime Dinner
        </h2>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground" data-testid="text-attribution-settings">
          {meta?.attribution ??
            "Recipes are fetched on demand from their publishers. Dime Dinner is an independent personal tool."}
        </p>
        <ul className="mt-3 space-y-1.5 text-xs leading-relaxed text-muted-foreground">
          <li>Everything is stored locally in a SQLite database inside the add-on&apos;s /data folder.</li>
          <li>No Home Assistant entities, services or automations are created — this is a display-only panel.</li>
          <li>Recipe pages are fetched only when you ask for them; nothing is bulk-copied or re-published.</li>
          <li>Kroger results reflect what the API reports for a store and are not a live inventory guarantee.</li>
          <li>Skylight exports are plain files you import yourself; there is no account connection or live sync.</li>
        </ul>
      </Card>
    </Layout>
  );
}
