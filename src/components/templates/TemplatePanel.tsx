"use client";

import { useState, useCallback, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Palette, Save, Trash2, Upload } from "lucide-react";
import type { StyleTemplate } from "@/lib/types/editCommand";
import type { StyleProfile } from "@/lib/types/styleProfile";

const STORAGE_KEY = "styleclone_templates";

interface TemplatePanelProps {
  currentProfile: StyleProfile | null;
  onLoadTemplate: (profile: StyleProfile) => void;
}

export function TemplatePanel({ currentProfile, onLoadTemplate }: TemplatePanelProps) {
  const [templates, setTemplates] = useState<StyleTemplate[]>([]);
  const [saveName, setSaveName] = useState("");
  const [showSave, setShowSave] = useState(false);

  // Load templates from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) setTemplates(JSON.parse(stored));
    } catch {}
  }, []);

  const persistTemplates = useCallback((updated: StyleTemplate[]) => {
    setTemplates(updated);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    } catch {}
  }, []);

  const saveTemplate = useCallback(() => {
    if (!currentProfile || !saveName.trim()) return;

    const template: StyleTemplate = {
      id: `tpl_${Date.now()}`,
      name: saveName.trim(),
      description: `${currentProfile.segments.length} segments, ${currentProfile.color_grade.temperature} grade`,
      createdAt: new Date().toISOString(),
      styleProfile: currentProfile as unknown as Record<string, unknown>,
      tags: [
        currentProfile.color_grade.temperature,
        currentProfile.pip_style.shape,
        `${currentProfile.segments.length} segments`,
      ],
    };

    persistTemplates([template, ...templates]);
    setSaveName("");
    setShowSave(false);
  }, [currentProfile, saveName, templates, persistTemplates]);

  const deleteTemplate = useCallback(
    (id: string) => {
      persistTemplates(templates.filter((t) => t.id !== id));
    },
    [templates, persistTemplates]
  );

  const loadTemplate = useCallback(
    (template: StyleTemplate) => {
      onLoadTemplate(template.styleProfile as unknown as StyleProfile);
    },
    [onLoadTemplate]
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-1.5">
            <Palette className="h-3.5 w-3.5" />
            Style Templates
          </CardTitle>
          {currentProfile && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[11px] gap-1"
              onClick={() => setShowSave(!showSave)}
            >
              <Save className="h-3 w-3" />
              Save Current
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {/* Save form */}
        {showSave && (
          <div className="flex gap-1.5">
            <input
              type="text"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="Template name..."
              className="flex-1 rounded-md border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
              onKeyDown={(e) => e.key === "Enter" && saveTemplate()}
            />
            <Button size="sm" className="h-7 text-xs" onClick={saveTemplate} disabled={!saveName.trim()}>
              Save
            </Button>
          </div>
        )}

        {/* Template list */}
        {templates.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-3">
            No saved templates. Analyze a reference video and save its style.
          </p>
        ) : (
          <div className="space-y-1.5">
            {templates.map((tpl) => (
              <div
                key={tpl.id}
                className="flex items-center gap-2 p-2 rounded-md border hover:bg-muted/50 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate">{tpl.name}</p>
                  <div className="flex gap-1 mt-0.5">
                    {tpl.tags.map((tag, i) => (
                      <Badge key={i} variant="secondary" className="text-[8px]">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 shrink-0"
                  onClick={() => loadTemplate(tpl)}
                  title="Load template"
                >
                  <Upload className="h-3 w-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 shrink-0 text-red-500 hover:text-red-600"
                  onClick={() => deleteTemplate(tpl.id)}
                  title="Delete template"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
