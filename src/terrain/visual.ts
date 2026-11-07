/** Visual settings that shape materials and water without changing the terrain. */
import { defaultMaterialSettings, type MaterialSettings } from "./materials";
import { defaultWaterVisual, type WaterVisualSettings } from "./waterVisual";

export interface VisualSettings {
  material: MaterialSettings;
  water: WaterVisualSettings;
}

export const defaultVisualSettings = (): VisualSettings => ({
  material: defaultMaterialSettings(),
  water: defaultWaterVisual(),
});

export const cloneVisual = (v: VisualSettings): VisualSettings => ({
  material: { ...v.material },
  water: { ...v.water },
});
