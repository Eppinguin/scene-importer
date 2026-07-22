import OBR from "@owlbear-rodeo/sdk";
import {
    FOUNDRY_MAP_IDENTITY_KEY,
    readFoundryMapIdentity,
} from "./foundryMapMetadata";
const ID = "com.eppinguin.scene-importer";

export function setupContextMenu() {
    OBR.contextMenu.create({
        id: `${ID}/context-menu`,
        icons: [
            {
                icon: "/Icon.svg",
                label: "Import Walls",
                filter: {
                    every: [{ key: "layer", value: "MAP" }],
                    max: 1,
                    permissions: ["FOG_CREATE"],
                },
            },
        ],
        onClick: async (context) => {
            const selectedMap = context.items.find((item) => item.layer === "MAP");
            const anchorMapId = selectedMap?.id;
            const anchorMapName = selectedMap?.name;
            const foundryIdentity = readFoundryMapIdentity(
                selectedMap?.metadata?.[FOUNDRY_MAP_IDENTITY_KEY]
            );
            const query = new URLSearchParams({ context: "true" });
            if (typeof anchorMapId === "string" && anchorMapId.trim().length > 0) {
                query.set("anchorMapId", anchorMapId);
            }
            if (typeof anchorMapName === "string" && anchorMapName.trim().length > 0) {
                query.set("anchorMapName", anchorMapName);
            }
            if (foundryIdentity) {
                query.set("anchorSceneId", foundryIdentity.sceneId);
                query.set("anchorLogicalMapId", foundryIdentity.logicalMapId);
                query.set("anchorLayerId", foundryIdentity.layerId);
            }
            const width = 600;
            const height = 560;
            await OBR.modal.open({
                id: `${ID}/modal`,
                url: `/index.html?${query.toString()}`,
                height: height,
                width: width
            });
        }
    });
}
