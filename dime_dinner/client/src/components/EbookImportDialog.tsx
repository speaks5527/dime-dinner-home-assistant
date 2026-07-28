/**
 * The "Import PDF or ebook" flow.
 *
 * Two screens in one dialog: a start screen that takes either a file or a
 * link, and a review screen listing every recipe found. Because the reading
 * itself happens on the server and takes minutes, the middle of the flow is a
 * progress bar fed by polling, with a cancel button that actually stops the
 * work.
 *
 * Nothing is saved until the user ticks recipes and presses the save button.
 * OCR gets things wrong, so every field on the review screen is editable and
 * the low-confidence candidates arrive unticked with their warnings showing.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, BookOpen, FileUp, Link2, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { API_BASE, apiRequest, queryClient } from "@/lib/queryClient";
import { postJson } from "@/lib/app";
import { EBOOK_CONFIDENT, type EbookImportJob, type EbookSaveResult, type InstructionGroup } from "@shared/schema";

const POLL_MS = 1200;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

type Draft = {
  selected: boolean;
  title: string;
  ingredients: string;
  instructions: string;
};

function groupsToText(groups: InstructionGroup[]): string {
  return groups
    .map((group) => {
      const steps = group.steps.map((step) => step.text).join("\n");
      return group.heading ? `${group.heading}\n${steps}` : steps;
    })
    .join("\n\n");
}

/** One blank line starts a new named block; its first line is the heading. */
function textToGroups(text: string): InstructionGroup[] {
  return text
    .split(/\n\s*\n/)
    .map((block, index) => {
      const lines = block
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (!lines.length) return null;
      // A short opening line in a later block is a sub-heading like
      // "Alternative method", not a step.
      const heading = index > 0 && lines.length > 1 && lines[0].length < 60 && !/[.]$/.test(lines[0]);
      const steps = (heading ? lines.slice(1) : lines).map((line) => ({ text: line }));
      if (!steps.length) return null;
      return heading ? { heading: lines[0], steps } : { steps };
    })
    .filter((group): group is InstructionGroup => group !== null);
}

function cleanMessage(error: Error): string {
  return error.message.replace(/^\d+:\s*/, "").replace(/^\{"message":"|"\}$/g, "");
}

export function EbookImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { toast } = useToast();
  const [url, setUrl] = useState("");
  const [job, setJob] = useState<EbookImportJob | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [starting, setStarting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const jobId = job?.id ?? null;
  const running = !!job && !["ready", "failed", "cancelled"].includes(job.phase);

  /* Poll while the server is still working. */
  useEffect(() => {
    if (!jobId || !running) return;
    let live = true;
    const timer = setInterval(async () => {
      try {
        const res = await apiRequest("GET", `/api/ebook/${jobId}`);
        const next = (await res.json()) as EbookImportJob;
        if (live) setJob(next);
      } catch {
        // A lost poll is not fatal — the next tick retries, and an expired job
        // surfaces through its own status.
      }
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [jobId, running]);

  /* Seed the editable drafts once the candidates arrive. */
  useEffect(() => {
    if (job?.phase !== "ready") return;
    setDrafts((current) => {
      if (Object.keys(current).length) return current;
      const seeded: Record<string, Draft> = {};
      for (const candidate of job.candidates) {
        seeded[candidate.id] = {
          // A shaky read starts unticked so it cannot be saved by reflex.
          selected: candidate.confidence >= EBOOK_CONFIDENT && !!candidate.title,
          title: candidate.title ?? "",
          ingredients: candidate.ingredients.join("\n"),
          instructions: groupsToText(candidate.instructions),
        };
      }
      return seeded;
    });
  }, [job]);

  function reset() {
    setJob(null);
    setDrafts({});
    setUrl("");
    if (fileInput.current) fileInput.current.value = "";
  }

  async function startUrl() {
    if (!url.trim()) return;
    setStarting(true);
    try {
      setJob(await postJson<EbookImportJob>("/api/ebook/url", { url: url.trim() }));
      setDrafts({});
    } catch (error) {
      toast({ title: "Could not start that import", description: cleanMessage(error as Error), variant: "destructive" });
    } finally {
      setStarting(false);
    }
  }

  async function startUpload(file: File) {
    if (file.size > MAX_UPLOAD_BYTES) {
      toast({
        title: "That file is too big",
        description: `${(file.size / 1_048_576).toFixed(1)} MB — the limit is ${MAX_UPLOAD_BYTES / 1_048_576} MB.`,
        variant: "destructive",
      });
      return;
    }
    setStarting(true);
    try {
      const res = await fetch(`${API_BASE}/api/ebook/upload?filename=${encodeURIComponent(file.name)}`, {
        method: "POST",
        headers: { "Content-Type": "application/pdf" },
        body: file,
      });
      if (!res.ok) throw new Error((await res.text()) || res.statusText);
      setJob((await res.json()) as EbookImportJob);
      setDrafts({});
    } catch (error) {
      toast({ title: "Could not read that file", description: cleanMessage(error as Error), variant: "destructive" });
    } finally {
      setStarting(false);
    }
  }

  async function cancel() {
    if (!jobId) return;
    try {
      await apiRequest("DELETE", `/api/ebook/${jobId}`);
    } catch {
      // Already gone on the server; the local reset below is what matters.
    }
    reset();
  }

  const selectedIds = useMemo(
    () => Object.entries(drafts).filter(([, draft]) => draft.selected).map(([id]) => id),
    [drafts],
  );

  const save = useMutation({
    mutationFn: () =>
      postJson<EbookSaveResult>(`/api/ebook/${jobId}/save`, {
        confirm: true,
        selections: selectedIds.map((id) => {
          const draft = drafts[id];
          const candidate = job?.candidates.find((c) => c.id === id);
          return {
            id,
            title: draft.title.trim(),
            ingredients: draft.ingredients.split("\n").map((line) => line.trim()).filter(Boolean),
            instructions: textToGroups(draft.instructions),
            description: candidate?.description ?? null,
            servings: candidate?.servings ?? null,
            totalMinutes: candidate?.totalMinutes ?? null,
          };
        }),
      }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/recipes"] });
      toast({
        title: `Saved ${result.saved.length} recipe${result.saved.length === 1 ? "" : "s"}`,
        description: result.skipped.length ? `${result.skipped.length} were skipped.` : undefined,
      });
      reset();
      onOpenChange(false);
    },
    onError: (error: Error) =>
      toast({ title: "Could not save", description: cleanMessage(error), variant: "destructive" }),
  });

  const badDrafts = selectedIds.filter(
    (id) => !drafts[id].title.trim() || !drafts[id].ingredients.trim() || !drafts[id].instructions.trim(),
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && running) void cancel();
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="flex max-h-[92vh] max-w-3xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border p-5 pb-4">
          <DialogTitle className="flex items-center gap-2 font-display">
            <BookOpen className="h-5 w-5 text-primary" /> Import PDF or ebook
          </DialogTitle>
          <DialogDescription>
            Read a recipe PDF from your device or a public link, then choose which recipes to keep.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {!job && <StartScreen {...{ url, setUrl, startUrl, startUpload, starting, fileInput }} />}

          {job && running && <ProgressScreen job={job} onCancel={cancel} />}

          {job && job.phase === "failed" && (
            <div className="space-y-4" data-testid="ebook-error">
              <div className="flex gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-4">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
                <p className="text-sm leading-relaxed">{job.error}</p>
              </div>
              <Button variant="outline" onClick={reset} data-testid="button-ebook-retry">
                Try another file or link
              </Button>
            </div>
          )}

          {job && job.phase === "cancelled" && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">Import cancelled. Nothing was saved.</p>
              <Button variant="outline" onClick={reset}>
                Start again
              </Button>
            </div>
          )}

          {job && job.phase === "ready" && (
            <ReviewScreen job={job} drafts={drafts} setDrafts={setDrafts} />
          )}
        </div>

        {job?.phase === "ready" && (
          <div className="flex flex-col gap-3 border-t border-border p-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-muted-foreground" data-testid="text-ebook-selected">
              {selectedIds.length} of {job.candidates.length} selected
              {badDrafts.length ? " — some selected recipes are missing a title, ingredients or steps." : ""}
            </p>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={reset} data-testid="button-ebook-discard">
                Discard
              </Button>
              <Button
                onClick={() => save.mutate()}
                disabled={!selectedIds.length || !!badDrafts.length || save.isPending}
                data-testid="button-ebook-save"
              >
                {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save {selectedIds.length || ""} to my library
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------- sub-screens ------------------------------ */

function StartScreen({
  url,
  setUrl,
  startUrl,
  startUpload,
  starting,
  fileInput,
}: {
  url: string;
  setUrl: (value: string) => void;
  startUrl: () => void;
  startUpload: (file: File) => void;
  starting: boolean;
  fileInput: React.RefObject<HTMLInputElement>;
}) {
  return (
    <div className="space-y-5">
      <div>
        <label htmlFor="ebook-url" className="mb-2 flex items-center gap-2 text-sm font-medium">
          <Link2 className="h-4 w-4 text-primary" /> Link to a PDF
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="ebook-url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && startUrl()}
            placeholder="https://www.dropbox.com/scl/fi/…/cookbook.pdf?rlkey=…"
            inputMode="url"
            data-testid="input-ebook-url"
          />
          <Button onClick={startUrl} disabled={starting || !url.trim()} data-testid="button-ebook-start-url">
            {starting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Read it
          </Button>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          A direct PDF, a Dropbox or Google Drive share link, or the page that offers the download — Dime Dinner will
          show you which file it picked before reading it. Links that need a sign-in or an email address cannot be
          fetched; download those in your browser and upload the file instead.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Separator className="flex-1" />
        <span className="text-xs uppercase tracking-wider text-muted-foreground">or</span>
        <Separator className="flex-1" />
      </div>

      <div>
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf,.pdf"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) startUpload(file);
          }}
          data-testid="input-ebook-file"
        />
        <Button
          variant="outline"
          className="w-full"
          onClick={() => fileInput.current?.click()}
          disabled={starting}
          data-testid="button-ebook-upload"
        >
          <FileUp className="mr-2 h-4 w-4" /> Choose a PDF from this device
        </Button>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Up to 25 MB and 60 pages. Scanned or image-only cookbooks are read with on-device OCR — nothing is sent to any
          outside service. The PDF itself is deleted as soon as it has been read; only the recipes you pick are saved,
          for your own personal use.
        </p>
      </div>
    </div>
  );
}

function ProgressScreen({ job, onCancel }: { job: EbookImportJob; onCancel: () => void }) {
  return (
    <div className="space-y-4" data-testid="ebook-progress">
      <div className="flex items-center gap-3">
        <Loader2 className="h-5 w-5 shrink-0 animate-spin text-primary" />
        <p className="text-sm font-medium" data-testid="text-ebook-phase">
          {job.message}
        </p>
      </div>
      <Progress value={job.percent} />

      {job.resolution && (
        <div className="rounded-md border border-border bg-muted/40 p-3">
          <p className="text-xs font-medium">Reading {job.filename}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{job.resolution}</p>
          {job.alternatives.length > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              Not the right file? Other links on that page: {job.alternatives.join(", ")}
            </p>
          )}
        </div>
      )}

      {job.usedOcr && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          These pages are images rather than text, so each one is being read with OCR. On a Raspberry Pi a 50-page book
          takes a few minutes.
        </p>
      )}

      <Button variant="outline" onClick={onCancel} data-testid="button-ebook-cancel">
        <X className="mr-2 h-4 w-4" /> Cancel
      </Button>
    </div>
  );
}

function ReviewScreen({
  job,
  drafts,
  setDrafts,
}: {
  job: EbookImportJob;
  drafts: Record<string, Draft>;
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, Draft>>>;
}) {
  const update = (id: string, patch: Partial<Draft>) =>
    setDrafts((current) => ({ ...current, [id]: { ...current[id], ...patch } }));

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border bg-muted/40 p-3">
        <p className="text-sm font-medium">
          {job.candidates.length} recipe{job.candidates.length === 1 ? "" : "s"} found in {job.title ?? job.filename}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {job.author ? `${job.author} · ` : ""}
          {job.pageCount} pages
          {job.skippedPages.length ? ` · ${job.skippedPages.length} pages were not recipes and were skipped` : ""}
        </p>
        {job.warnings.map((warning) => (
          <p key={warning} className="mt-2 text-xs leading-relaxed text-amber-700 dark:text-amber-500">
            {warning}
          </p>
        ))}
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Recipes are saved to your own library for personal use and credited to the book above. Dime Dinner is an
          independent tool and is not affiliated with the book or its author.
        </p>
      </div>

      {job.candidates.map((candidate) => {
        const draft = drafts[candidate.id];
        if (!draft) return null;
        const shaky = candidate.confidence < EBOOK_CONFIDENT;
        return (
          <Card
            key={candidate.id}
            className={`border-card-border p-4 ${draft.selected ? "ring-1 ring-primary/40" : ""}`}
            data-testid={`card-candidate-${candidate.id}`}
          >
            <div className="flex items-start gap-3">
              <Checkbox
                checked={draft.selected}
                onCheckedChange={(checked) => update(candidate.id, { selected: checked === true })}
                className="mt-1"
                aria-label={`Import ${draft.title || "this recipe"}`}
                data-testid={`checkbox-candidate-${candidate.id}`}
              />
              <div className="min-w-0 flex-1 space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary" className="text-[11px]">
                    Page {candidate.pages.join(", ")}
                  </Badge>
                  <Badge variant={shaky ? "destructive" : "outline"} className="text-[11px]">
                    {Math.round(candidate.confidence * 100)}% confident
                  </Badge>
                </div>

                {candidate.warnings.map((warning) => (
                  <p
                    key={warning}
                    className="flex gap-1.5 text-xs leading-relaxed text-amber-700 dark:text-amber-500"
                  >
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {warning}
                  </p>
                ))}

                <div className="flex flex-col gap-3 sm:flex-row">
                  <img
                    src={`${API_BASE}/api/ebook/${job.id}/page/${candidate.pages[0]}.png`}
                    alt=""
                    className="h-auto w-full max-w-[130px] self-start rounded border border-border"
                    onError={(event) => {
                      event.currentTarget.style.display = "none";
                    }}
                  />
                  <div className="min-w-0 flex-1 space-y-2">
                    <Input
                      value={draft.title}
                      onChange={(event) => update(candidate.id, { title: event.target.value })}
                      placeholder="Recipe title"
                      aria-label="Recipe title"
                      data-testid={`input-title-${candidate.id}`}
                    />
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">
                        Ingredients — one per line
                      </label>
                      <Textarea
                        value={draft.ingredients}
                        onChange={(event) => update(candidate.id, { ingredients: event.target.value })}
                        rows={Math.min(12, Math.max(4, draft.ingredients.split("\n").length))}
                        className="text-sm"
                        data-testid={`input-ingredients-${candidate.id}`}
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">
                        Instructions — one step per line
                      </label>
                      <Textarea
                        value={draft.instructions}
                        onChange={(event) => update(candidate.id, { instructions: event.target.value })}
                        rows={Math.min(14, Math.max(4, draft.instructions.split("\n").length))}
                        className="text-sm"
                        data-testid={`input-instructions-${candidate.id}`}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
