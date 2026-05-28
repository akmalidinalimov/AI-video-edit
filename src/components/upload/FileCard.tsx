"use client";

import { Film, Image as ImageIcon, X, CheckCircle, Loader2 } from "lucide-react";
import type { UploadedFile } from "@/lib/types/project";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

interface FileCardProps {
  file: UploadedFile;
  onRemove?: () => void;
}

export function FileCard({ file, onRemove }: FileCardProps) {
  const Icon = file.type === "video" ? Film : ImageIcon;

  return (
    <div className="flex items-center gap-3 rounded-md border p-2 bg-card">
      <div className="flex h-10 w-10 items-center justify-center rounded bg-muted">
        <Icon className="h-5 w-5 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{file.name}</p>
        <div className="flex items-center gap-2">
          {file.status === "uploading" && (
            <Progress value={file.progress} className="h-1 flex-1" />
          )}
          {file.status === "processing" && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Processing...
            </span>
          )}
          {file.status === "complete" && (
            <span className="flex items-center gap-1 text-xs text-green-600">
              <CheckCircle className="h-3 w-3" />
              Ready
            </span>
          )}
          {file.status === "error" && (
            <span className="text-xs text-destructive">Upload failed</span>
          )}
          {file.status === "idle" && (
            <span className="text-xs text-muted-foreground">
              {(file.size / (1024 * 1024)).toFixed(1)} MB
            </span>
          )}
        </div>
      </div>
      {onRemove && (
        <button
          onClick={onRemove}
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded-full hover:bg-muted transition-colors",
            "text-muted-foreground hover:text-foreground"
          )}
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
