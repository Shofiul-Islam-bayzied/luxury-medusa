import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import PayStationProviderService from "./service"

export default ModuleProvider(Modules.PAYMENT, {
  services: [PayStationProviderService],
})
