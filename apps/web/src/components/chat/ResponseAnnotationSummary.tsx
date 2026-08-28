import type { ResponseAnnotation, ResponseAnnotationId } from "@t3tools/contracts";
import { MessageSquareTextIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

interface ResponseAnnotationSummaryProps {
  readonly annotations: ReadonlyArray<ResponseAnnotation>;
  readonly editable?: boolean;
  readonly placement?: "composer" | "message";
  readonly onJump: (annotation: ResponseAnnotation) => void;
  readonly onRemove?: (annotationId: ResponseAnnotationId) => void;
}

export function ResponseAnnotationSummary({
  annotations,
  editable = false,
  placement = "message",
  onJump,
  onRemove,
}: ResponseAnnotationSummaryProps) {
  const [open, setOpen] = useState(false);
  if (annotations.length === 0) return null;
  const label = `${annotations.length} ${annotations.length === 1 ? "annotation" : "annotations"}`;

  return (
    <Popover open={open} onOpenChange={(nextOpen) => setOpen(nextOpen)}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="outline"
            className={cn(
              "h-7 gap-1.5 rounded-full px-2.5 font-medium",
              placement === "message" &&
                "border-message-foreground/15 bg-transparent text-message-foreground hover:bg-message-foreground/8",
            )}
            aria-label={`${label}. Open annotation list`}
          >
            <MessageSquareTextIcon className="size-3.5" aria-hidden="true" />
            {label}
          </Button>
        }
      />
      <PopoverPopup
        side={placement === "composer" ? "top" : "bottom"}
        align={placement === "composer" ? "start" : "end"}
        className="w-80 max-w-[min(20rem,calc(100vw-1rem))]"
        viewportClassName="p-1"
      >
        <div className="px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">
          Response annotations
        </div>
        <div className="max-h-72 overflow-y-auto overscroll-contain">
          {annotations.map((annotation, index) => (
            <div
              key={annotation.id}
              className="group/item flex items-start gap-1 rounded-md hover:bg-muted/70"
            >
              <button
                type="button"
                className="min-w-0 flex-1 px-2 py-2 text-left"
                onClick={() => {
                  setOpen(false);
                  onJump(annotation);
                }}
                aria-label={`Go to Annotation ${index + 1}`}
              >
                <span className="block text-xs font-medium text-foreground">
                  Annotation {index + 1}
                </span>
                <span className="mt-0.5 line-clamp-2 block text-xs leading-4 text-muted-foreground">
                  {annotation.selectedText}
                </span>
                {annotation.comment.trim().length > 0 ? (
                  <span className="mt-1 line-clamp-2 block text-xs leading-4 text-foreground/80">
                    {annotation.comment}
                  </span>
                ) : null}
              </button>
              {editable && onRemove ? (
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  className="me-1 mt-1.5 shrink-0 text-muted-foreground opacity-70 hover:text-destructive group-hover/item:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpen(false);
                    onRemove(annotation.id);
                  }}
                  aria-label={`Delete Annotation ${index + 1}`}
                >
                  <Trash2Icon aria-hidden="true" />
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
