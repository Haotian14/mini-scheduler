/** The dashboard's top-level views, shared by the sidebar and the app shell. */
export type ViewName = "overview" | "tasks" | "workers";

export interface NavigationItem {
  view: ViewName;
  icon: string;
  label: string;
}

export const NAVIGATION: NavigationItem[] = [
  { view: "overview", icon: "⌂", label: "Overview" },
  { view: "tasks", icon: "⌘", label: "Tasks" },
  { view: "workers", icon: "◇", label: "Workers" },
];
