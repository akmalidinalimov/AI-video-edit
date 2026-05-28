"use client";

import { DropZone } from "@/components/upload/DropZone";
import { FileCard } from "@/components/upload/FileCard";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import type { UploadedFile } from "@/lib/types/project";

interface UploadPanelProps {
  referenceFile: UploadedFile | null;
  arollFiles: UploadedFile[];
  brollFiles: UploadedFile[];
  onReferenceUpload: (files: File[]) => void;
  onArollUpload: (files: File[]) => void;
  onBrollUpload: (files: File[]) => void;
  onRemoveReference: () => void;
  onRemoveAroll: (id: string) => void;
  onRemoveBroll: (id: string) => void;
}

export function UploadPanel({
  referenceFile,
  arollFiles,
  brollFiles,
  onReferenceUpload,
  onArollUpload,
  onBrollUpload,
  onRemoveReference,
  onRemoveAroll,
  onRemoveBroll,
}: UploadPanelProps) {
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-4 p-4">
        <div>
          <h3 className="text-sm font-semibold mb-2">Reference Video</h3>
          <p className="text-xs text-muted-foreground mb-2">
            Upload the video whose editing style you want to clone
          </p>
          {referenceFile ? (
            <FileCard file={referenceFile} onRemove={onRemoveReference} />
          ) : (
            <DropZone
              label="Drop reference video"
              description="MP4, MOV up to 200MB"
              accept="video/*"
              icon="video"
              onFilesSelected={onReferenceUpload}
            />
          )}
        </div>

        <Separator />

        <div>
          <h3 className="text-sm font-semibold mb-2">
            A-Roll
            {arollFiles.length > 0 && (
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                ({arollFiles.length})
              </span>
            )}
          </h3>
          <p className="text-xs text-muted-foreground mb-2">
            Your talking head clips — upload multiple and we'll detect silence and sequence them
          </p>
          <DropZone
            label="Drop your A-roll clips"
            description="MP4, MOV — multiple files supported"
            accept="video/*"
            multiple
            icon="video"
            onFilesSelected={onArollUpload}
          />
          {arollFiles.length > 0 && (
            <div className="mt-2 flex flex-col gap-1.5">
              {arollFiles.map((file) => (
                <FileCard
                  key={file.id}
                  file={file}
                  onRemove={() => onRemoveAroll(file.id)}
                />
              ))}
            </div>
          )}
        </div>

        <Separator />

        <div>
          <h3 className="text-sm font-semibold mb-2">
            B-Roll Assets
            {brollFiles.length > 0 && (
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                ({brollFiles.length})
              </span>
            )}
          </h3>
          <p className="text-xs text-muted-foreground mb-2">
            Images and videos for background/overlay
          </p>
          <DropZone
            label="Drop B-roll files"
            description="Images or videos, multiple files supported"
            accept="video/*,image/*"
            multiple
            icon="image"
            onFilesSelected={onBrollUpload}
          />
          {brollFiles.length > 0 && (
            <div className="mt-2 flex flex-col gap-1.5">
              {brollFiles.map((file) => (
                <FileCard
                  key={file.id}
                  file={file}
                  onRemove={() => onRemoveBroll(file.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </ScrollArea>
  );
}
