import type { Metadata } from "next";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/card";
import { PageHeader } from "@/components/page-header";
import { ThemeSelector } from "./_components/theme-selector";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return (
    <>
      <PageHeader
        title="Settings"
        description="Preferences for how AI Specification Studio looks in this browser."
      />
      <Card>
        <CardHeader>
          <CardTitle as="h2">Appearance</CardTitle>
          <CardDescription>
            Choose a color theme. Dark is the default.
          </CardDescription>
        </CardHeader>
        <ThemeSelector />
      </Card>
    </>
  );
}
