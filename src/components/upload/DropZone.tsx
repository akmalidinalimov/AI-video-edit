"use client";

import { useCallback, useRef, useState } from "react";
import { Upload, Film, Image as ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface DropZoneProps {
  label: string;
  description: string;
  accept: string;
  multiple?: boolean;
  icon?: "video" | "image" | "any";
  onFilesSelected: (files: File[]) => void;
  disabled?: boolean;
}

export function DropZone({
  label,
  description,
  accept,
  multiple = false,
  icon = "any",
  onFilesSelected,
  disabled = false,
}: DropZoneProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      if (disabled) return;

      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) {
        onFilesSelected(multiple ? files : [files[0]]);
      }
    },
    [disabled, multiple, onFilesSelected]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleClick = useCallback(() => {
    if (disabled) return;
    inputRef.current?.click();
  }, [disabled]);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      if (files.length > 0) {
        onFilesSelected(files);
      }
      if (inputRef.current) inputRef.current.value = "";
    },
    [onFilesSelected]
  );

  const IconComponent = icon === "video" ? Film : icon === "image" ? ImageIcon : Upload;

  return (
    <div
      className={cn(
        "relative flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 transition-colors cursor-pointer",
        isDragOver && "border-primary bg-primary/5",
        !isDragOver && "border-muted-foreground/25 hover:border-muted-foreground/50",
        disabled && "opacity-50 cursor-not-allowed"
      )}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onClick={handleClick}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={handleInputChange}
        className="hidden"
        data-testid="file-input"
      />
      <IconComponent className="h-8 w-8 text-muted-foreground" />
      <p className="text-sm font-medium">{label}</p>
      <p className="text-xs text-muted-foreground text-center">{description}</p>
    </div>
  );
}
