import OBR from "@owlbear-rodeo/sdk";
const ID = "com.eppinguin.uvtt-importer";

export function setupContextMenu() {
    OBR.contextMenu.create({
        id: `${ID}/context-menu`,
        icons: [
            {
                icon: "/Icon.svg",
                label: "Import Walls",
                filter: {
                    every: [{ key: "layer", value: "MAP" }],
                    permissions: ["FOG_CREATE"],
                },
            },
        ],
        onClick: async () => {
            const width = 600;
            const height = 700;
            await OBR.modal.open({
                id: `${ID}/modal`,
                url: "/index.html?context=true",
                height: height,
                width: width
            });
        }
    });
}


