import { createFileRoute } from "@tanstack/react-router";
import { PublicSelenaScan } from "./selena";

export const Route = createFileRoute("/check")({ component: PublicSelenaScan });
