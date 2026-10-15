import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ProviderSetupCatalogEntryDto,
  ProviderTemplateCatalogEntryDto,
} from "../src/generated/types.gen.ts";
import {
  zProviderSetupCatalogEntryDto,
  zProviderSetupMethodDto,
  zProviderTemplateCatalogEntryDto,
} from "../src/generated/zod.gen.ts";

test("provider setup schema carries activation-disabled state end to end", () => {
  const disabledEntry: ProviderSetupCatalogEntryDto = {
    providerId: "zai",
    name: "Z.AI",
    category: "model",
    description: "Unavailable",
    setupMethod: "disabled",
    enabled: false,
    disabledReason: "Provider activation is disabled",
    group: "additional",
    showOnlyWhenInstalled: false,
    supportsInstall: false,
    supportsAuth: false,
    supportsAuthStatus: false,
  };

  assert.equal(zProviderSetupMethodDto.parse("disabled"), "disabled");
  assert.deepEqual(zProviderSetupCatalogEntryDto.parse(disabledEntry), {
    ...disabledEntry,
    aliases: [],
    fields: [],
  });
  assert.equal(
    zProviderSetupCatalogEntryDto.safeParse({
      ...disabledEntry,
      enabled: undefined,
    }).success,
    false,
  );
});

test("provider template catalog schema carries activation-disabled state end to end", () => {
  const disabledEntry: ProviderTemplateCatalogEntryDto = {
    providerId: "nvidia",
    name: "NVIDIA",
    format: "openai",
    apiUrl: "https://integrate.api.nvidia.com/v1",
    modelCount: 1,
    docUrl: "https://example.invalid/docs",
    envVar: "NVIDIA_API_KEY",
    enabled: false,
    disabledReason: "Provider activation is disabled",
  };

  assert.deepEqual(
    zProviderTemplateCatalogEntryDto.parse(disabledEntry),
    disabledEntry,
  );
  assert.equal(
    zProviderTemplateCatalogEntryDto.safeParse({
      ...disabledEntry,
      enabled: undefined,
    }).success,
    false,
  );
});
