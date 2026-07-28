import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  Loader2,
  ShoppingCart,
  Unplug,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { copyText, postJson } from "@/lib/app";
import type { KrogerAuthState } from "@shared/schema";

const STATUS_KEY = ["/api/kroger/auth/status"];

function formatConnectedAt(value: number | null): string | null {
  if (!value) return null;
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function KrogerAccountCard({ auth }: { auth: KrogerAuthState | undefined }) {
  const { toast } = useToast();
  const [redirectUri, setRedirectUri] = useState("");
  const [copied, setCopied] = useState(false);
  const [awaitingConsent, setAwaitingConsent] = useState(false);
  const wasConnected = useRef(false);

  // While the Kroger tab is open the add-on has no way of knowing the user
  // finished, so the status is polled until it flips.
  const { data: live } = useQuery<KrogerAuthState>({
    queryKey: STATUS_KEY,
    enabled: awaitingConsent,
    refetchInterval: awaitingConsent ? 2500 : false,
  });

  const state = live ?? auth;

  useEffect(() => {
    if (auth) setRedirectUri(auth.redirectUri);
  }, [auth?.redirectUri]);

  useEffect(() => {
    if (!state) return;
    if (state.connected && !wasConnected.current && awaitingConsent) {
      setAwaitingConsent(false);
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({
        title: "Kroger account connected",
        description: state.hasCartScope
          ? "You can now build a cart from the grocery list."
          : "Kroger did not grant cart access — enable the Cart API on your application and reconnect.",
      });
    }
    wasConnected.current = state.connected;
  }, [state?.connected, state?.hasCartScope, awaitingConsent]);

  const saveRedirect = useMutation({
    mutationFn: () => postJson("/api/settings", { kroger: { redirectUri } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      queryClient.invalidateQueries({ queryKey: STATUS_KEY });
      toast({ title: "Redirect URL saved", description: "Register this exact value in your Kroger application." });
    },
    onError: (error: Error) =>
      toast({ title: "Could not save the redirect URL", description: clean(error), variant: "destructive" }),
  });

  const connect = useMutation({
    mutationFn: () => postJson<{ authorizeUrl: string }>("/api/kroger/auth/start"),
    onSuccess: ({ authorizeUrl }) => {
      setAwaitingConsent(true);
      // Kroger's consent page refuses to render in a frame, and this panel is
      // itself framed by Home Assistant, so it has to be a new tab.
      window.open(authorizeUrl, "_blank", "noopener,noreferrer");
    },
    onError: (error: Error) =>
      toast({ title: "Could not start Kroger sign-in", description: clean(error), variant: "destructive" }),
  });

  const disconnect = useMutation({
    mutationFn: () => postJson("/api/kroger/auth/disconnect"),
    onSuccess: () => {
      setAwaitingConsent(false);
      queryClient.invalidateQueries({ queryKey: STATUS_KEY });
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({ title: "Kroger account disconnected", description: "The stored sign-in was deleted from this add-on." });
    },
  });

  const onCopy = async () => {
    const ok = await copyText(state?.redirectUri ?? redirectUri);
    setCopied(ok);
    if (!ok) toast({ title: "Could not copy", description: "Select the text and copy it manually.", variant: "destructive" });
    else setTimeout(() => setCopied(false), 2000);
  };

  const canConnect = !!state && state.credentialsReady && state.redirectUriValid;
  const connectedAt = formatConnectedAt(state?.connectedAt ?? null);

  return (
    <Card className="border-card-border p-5" data-testid="card-kroger-account">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-display text-base font-semibold">
            <ShoppingCart className="h-4 w-4 text-primary" /> Kroger account
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Optional, and separate from the lookups above. Signing in to your own Kroger account lets Dime Dinner put
            your grocery list into your Kroger cart — always after you review it item by item.
          </p>
        </div>
        {state?.connected ? (
          <Badge
            variant={state.hasCartScope ? "default" : "secondary"}
            className="shrink-0"
            data-testid="badge-kroger-connected"
          >
            {state.hasCartScope ? "Connected" : "Connected, no cart access"}
          </Badge>
        ) : (
          <Badge variant="outline" className="shrink-0" data-testid="badge-kroger-disconnected">
            Not connected
          </Badge>
        )}
      </div>

      <p className="mt-3 text-xs text-muted-foreground" data-testid="text-kroger-auth-message">
        {state?.message ?? "Loading…"}
      </p>

      {state?.connected && connectedAt && (
        <dl className="mt-3 grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-2">
          <div>
            <dt className="inline font-medium">Signed in:</dt> <dd className="inline">{connectedAt}</dd>
          </div>
          <div>
            <dt className="inline font-medium">Granted:</dt>{" "}
            <dd className="inline">{state.scopes.length ? state.scopes.join(", ") : "none reported"}</dd>
          </div>
          {!state.canRefresh && (
            <div className="sm:col-span-2">
              Kroger did not return a refresh token, so you will be asked to sign in again when this one expires.
            </div>
          )}
        </dl>
      )}

      {state && !state.hasCartScope && state.connected && (
        <Notice tone="warn" testId="notice-kroger-scope">
          This sign-in did not include <code>cart.basic:write</code>. Enable the Cart API on your Kroger application,
          then disconnect and connect again.
        </Notice>
      )}

      <div className="mt-4">
        <Label htmlFor="redirect-uri">Redirect URL (must match Kroger exactly)</Label>
        <div className="mt-1 flex gap-2">
          <Input
            id="redirect-uri"
            value={redirectUri}
            onChange={(e) => setRedirectUri(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            disabled={state?.redirectUriManagedByAddonOptions}
            className="font-mono text-xs"
            data-testid="input-kroger-redirect-uri"
          />
          <Button
            type="button"
            variant="secondary"
            size="icon"
            onClick={onCopy}
            aria-label="Copy redirect URL"
            data-testid="button-copy-redirect-uri"
          >
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          </Button>
        </div>
        {state?.redirectUriManagedByAddonOptions ? (
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Set by the <code>kroger_redirect_uri</code> add-on option. Change it in the add-on configuration.
          </p>
        ) : (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => saveRedirect.mutate()}
              disabled={saveRedirect.isPending || redirectUri === state?.redirectUri}
              data-testid="button-save-redirect-uri"
            >
              {saveRedirect.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              Save redirect URL
            </Button>
            <span className="text-[11px] text-muted-foreground">
              Use your Home Assistant hostname or IP with port {state?.callbackPort ?? 8099}.
            </span>
          </div>
        )}
        {state && !state.redirectUriValid && (
          <Notice tone="error" testId="notice-kroger-redirect-error">
            {state.redirectUriError}
          </Notice>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          onClick={() => connect.mutate()}
          disabled={!canConnect || connect.isPending || awaitingConsent}
          data-testid="button-connect-kroger"
        >
          {connect.isPending || awaitingConsent ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <ExternalLink className="mr-2 h-4 w-4" />
          )}
          {state?.connected ? "Reconnect Kroger account" : "Connect Kroger account"}
        </Button>

        {state?.connected && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button type="button" variant="ghost" size="sm" data-testid="button-disconnect-kroger">
                <Unplug className="mr-2 h-4 w-4" /> Disconnect
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Disconnect your Kroger account?</AlertDialogTitle>
                <AlertDialogDescription>
                  Dime Dinner deletes the stored sign-in from this add-on. Anything already in your Kroger cart stays
                  there. You can connect again at any time.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep connected</AlertDialogCancel>
                <AlertDialogAction onClick={() => disconnect.mutate()} data-testid="button-confirm-disconnect">
                  Disconnect
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>

      {awaitingConsent && (
        <Notice tone="info" testId="notice-kroger-waiting">
          A Kroger sign-in page opened in a new tab. Finish there, then come back — this page notices on its own. If no
          tab opened, allow pop-ups for Home Assistant and try again.
        </Notice>
      )}

      <details className="mt-4 rounded-md border border-border bg-muted/40 p-3 text-xs" data-testid="details-kroger-setup">
        <summary className="cursor-pointer font-medium">How to set this up at Kroger</summary>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 leading-relaxed text-muted-foreground">
          <li>
            Sign in at <span className="font-mono">developer.kroger.com</span> and open your application, or add one.
          </li>
          <li>
            Add the <strong>Products</strong>, <strong>Locations</strong> and <strong>Cart</strong> APIs to it. Cart is
            the one that allows adding items, and without it a sign-in still succeeds but cannot build a cart.
          </li>
          <li>
            Use a <strong>Production</strong> application. Certification-environment credentials sign in but do not
            reach a real cart.
          </li>
          <li>
            Register the redirect URL above <strong>exactly</strong> as shown — same scheme, host, port and path. Kroger
            compares it character for character.
          </li>
          <li>Copy the client ID and secret into the Kroger lookups card and save.</li>
          <li>
            Press <strong>Connect Kroger account</strong> and sign in with the Kroger customer account whose cart you
            want to fill. This is your shopper account, not the developer one.
          </li>
        </ol>
        <p className="mt-2 leading-relaxed text-muted-foreground">
          The redirect URL cannot be a Home Assistant ingress URL: those carry a session token that changes, so Kroger
          would stop recognising it. That is why the add-on publishes port {state?.callbackPort ?? 8099}, which serves
          nothing but this one sign-in path.
        </p>
      </details>
    </Card>
  );
}

function Notice({
  tone,
  children,
  testId,
}: {
  tone: "info" | "warn" | "error";
  children: React.ReactNode;
  testId: string;
}) {
  const styles = {
    info: "border-border bg-muted/60 text-muted-foreground",
    warn: "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200",
    error: "border-destructive/40 bg-destructive/10 text-destructive",
  }[tone];
  const Icon = tone === "info" ? CheckCircle2 : AlertTriangle;
  return (
    <p className={`mt-3 flex gap-2 rounded-md border p-2.5 text-[11px] leading-relaxed ${styles}`} data-testid={testId}>
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

/** Strip the `409: ` prefix apiRequest puts on a failure message. */
function clean(error: Error): string {
  return error.message.replace(/^\d+:\s*/, "");
}
