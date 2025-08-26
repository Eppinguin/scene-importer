import OBR from "@owlbear-rodeo/sdk";
import { addItemsFromVTT } from "./importVTT";

document.addEventListener("DOMContentLoaded", () => {
    const button = document.getElementById("import-button");
    if (button) {
        button.addEventListener("click", () => {
            // Create file input
            const input = document.createElement("input");
            input.type = "file";
            input.accept = ".uvtt,.dd2vtt,.json,application/json,application/octet-stream";
            input.style.display = "none";

            // Add to document temporarily
            document.body.appendChild(input);

            // Handle file selection
            input.addEventListener("change", async (event) => {
                const file = (event.target as HTMLInputElement).files?.[0];
                if (file) {
                    const fileName = file.name.toLowerCase();
                    const isValidExtension =
                        fileName.endsWith(".uvtt") ||
                        fileName.endsWith(".dd2vtt") ||
                        fileName.endsWith(".json");
                    const isValidType =
                        isValidExtension ||
                        file.type === "application/json" ||
                        file.type === "application/octet-stream";

                    if (isValidType) {
                        try {
                            await addItemsFromVTT(file, true);
                        } catch (error) {
                            console.error(error);
                            await OBR.notification.show(
                                "Error importing file. Make sure it's a valid VTT file.",
                                "ERROR"
                            );
                        }
                    } else {
                        await OBR.notification.show(
                            "Please select a valid .uvtt, .dd2vtt, or .json file",
                            "WARNING"
                        );
                    }
                }
                // Clean up
                document.body.removeChild(input);
            });

            // Trigger file selection
            input.click();
        });
    }
});
