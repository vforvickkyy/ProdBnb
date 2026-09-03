import { SupabaseClient } from "@supabase/supabase-js";

export interface CatalogItem {
  id: string;
  name: string;
}

async function listCatalog(supabase: SupabaseClient, table: "categories" | "amenities" | "use_cases"): Promise<CatalogItem[]> {
  const { data, error } = await supabase.from(table).select("id, name").order("name", { ascending: true });
  if (error) {
    throw error;
  }
  return data ?? [];
}

export const listCategories = (supabase: SupabaseClient): Promise<CatalogItem[]> => listCatalog(supabase, "categories");
export const listAmenities = (supabase: SupabaseClient): Promise<CatalogItem[]> => listCatalog(supabase, "amenities");
export const listUseCases = (supabase: SupabaseClient): Promise<CatalogItem[]> => listCatalog(supabase, "use_cases");
