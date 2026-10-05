# Echte Maldenhof-testdata (herkomst: mjop-learning)

Alleen voor `test/quantity-maldenhof-real.spec.js`. Niet gebruikt door de app zelf.

| Bestand | Herkomst |
|---|---|
| `maldenhof_DOC-005_DOC-006_v3.json` | Ongewijzigde kopie van `mjop-learning/reports/quantity/app_bundles/maldenhof_DOC-005_DOC-006_v3.json` (PR "Real Maldenhof Quantity Bundle v3"), gemaakt met `scripts/export_app_quantity_bundle.py` en gevalideerd met `scripts/validate_app_quantity_bundle.py`. sha256 `b1ca1d196eb720744ca7dc0fd2a71a59f350bf4dfa0ff2cde4f81fbe3a4a1933`. |
| `maldenhof_240_snapshot_excerpt.json` | Uitsnede uit de canonieke snapshot `BAGSNAP-431559474da45dcf` (adres Maldenhof 240 en de 3D BAG-attributen van pand 0363100012137996). In de test worden PDOK/BAG/3D BAG hiermee nagebootst: geen netwerkcalls. De BAG-pandgeometrie zit niet in de snapshot; de test gebruikt een klein vierkant rond het adrespunt. |

Tenant-scheiding: deze bundel bevat historische hoeveelheden van één VvE (Maldenhof 240–296) en hoort alleen in
een plan van die VvE. Hij bevat geen keuze en geen quantity resolution.
