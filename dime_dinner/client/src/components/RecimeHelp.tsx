/**
 * How to get a recipe out of ReciMe and into Dime Dinner.
 *
 * Neither route is discoverable from this app — the user has to do something
 * in ReciMe first — so the steps are spelled out rather than implied by a
 * placeholder. Collapsed by default so it does not crowd the import card.
 */
import { ChevronDown } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { RECIME_DISCLAIMER } from "@shared/recime";

export function RecimeHelp() {
  return (
    <Collapsible className="mt-3" data-testid="panel-recime-help">
      <CollapsibleTrigger
        className="group flex w-full items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
        data-testid="button-recime-help"
      >
        <ChevronDown className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-180" />
        Importing from ReciMe
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 space-y-3 rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
        <div>
          <p className="font-medium text-foreground">Share a link</p>
          <p className="mt-0.5">
            In ReciMe, open the recipe, tap Share and copy the link, then paste it in the box above. The link has to be
            a public share link — Dime Dinner will not sign in to ReciMe, so a private recipe has to be shared first.
          </p>
        </div>
        <div>
          <p className="font-medium text-foreground">Export a PDF</p>
          <p className="mt-0.5">
            On platforms where ReciMe offers it, export the recipe as a PDF and bring it in with{" "}
            <span className="font-medium">Import PDF or ebook</span> below. A ReciMe export is recognised
            automatically and read as one recipe even when the method runs over a page break. Scanned or printed copies
            go through OCR, so check the text before saving.
          </p>
        </div>
        <p className="border-t border-border pt-2">{RECIME_DISCLAIMER}</p>
      </CollapsibleContent>
    </Collapsible>
  );
}
