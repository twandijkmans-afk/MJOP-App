# Echte testdata (herkomst: mjop-learning)

Alleen voor `test/quantity-maldenhof-real.spec.js`, `test/quantity-doc012-real.spec.js` en `test/quantity-maldenhof-expanded-real.spec.js`. Niet gebruikt door de app zelf.

| Bestand | Herkomst |
|---|---|
| `maldenhof_DOC-005_DOC-006_v3.json` | Ongewijzigde kopie van `mjop-learning/reports/quantity/app_bundles/maldenhof_DOC-005_DOC-006_v3.json` (PR "Real Maldenhof Quantity Bundle v3"), gemaakt met `scripts/export_app_quantity_bundle.py` en gevalideerd met `scripts/validate_app_quantity_bundle.py`. sha256 `b1ca1d196eb720744ca7dc0fd2a71a59f350bf4dfa0ff2cde4f81fbe3a4a1933`. |
| `maldenhof_240_snapshot_excerpt.json` | Uitsnede uit de canonieke snapshot `BAGSNAP-431559474da45dcf` (adres Maldenhof 240 en de 3D BAG-attributen van pand 0363100012137996). In de test worden PDOK/BAG/3D BAG hiermee nagebootst: geen netwerkcalls. De BAG-pandgeometrie zit niet in de snapshot; de test gebruikt een klein vierkant rond het adrespunt. |
| `doc012_meppelweg_v3.json` | Ongewijzigde kopie van `mjop-learning/reports/quantity/app_bundles/doc012_meppelweg_v3.json` (PR "DOC-012 Quantity Activation + Bundle v3", merge `6cdff4e`), zelfde exporter en validator. sha256 `748ebcbe53e83afc06fd4dba67467f1014d3cc88c728b55c56c3adfd33e0a191`. |
| `maldenhof_expanded_v3.json` | Ongewijzigde kopie van `mjop-learning/reports/quantity/app_bundles/maldenhof_expanded_v3.json` (PR "Sloped Roof Quantity Activation v1"): dak-plat + dak-hellend, zelfde exporter en validator. sha256 `c78f387e66ce7963d7a434270350f0ee8fa4c9f232099f871e83ed202cd2975d`. |
| `doc012_meppelweg_819_snapshot_excerpt.json` | Uitsnede uit de canonieke snapshot `BAGSNAP-599d2f2004100011` (adres Meppelweg 819 en de 3D BAG-attributen van pand 0518100000354752). Pandgeometrie: klein vierkant rond het adrespunt. |

Tenant-scheiding: elke bundel bevat historische hoeveelheden van één VvE en hoort alleen in een plan van die VvE. Hij bevat geen keuze en geen quantity resolution.
