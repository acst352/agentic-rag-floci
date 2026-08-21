// Documentos de prueba para el seed. En producción, esto vendría de
// un pipeline de ingesta (S3, Confluence, PDFs, etc.).
export const policyDocuments = [
  {
    source: "hr/politica-vacaciones.md",
    content:
      "Todos los empleados tienen derecho a 22 días laborables de vacaciones al año. Las solicitudes deben presentarse al menos 2 semanas antes mediante el portal de RR.HH. El saldo no disfrutado antes del 31 de diciembre se pierde, salvo aprobación escrita del responsable directo.",
  },
  {
    source: "hr/politica-home-office.md",
    content:
      "El modelo de trabajo híbrido permite hasta 3 días de home office por semana, previa coordinación con el equipo. Las reuniones con clientes externos deben realizarse obligatoriamente desde la oficina. El equipo de IT provee laptop y monitor externos bajo solicitud.",
  },
  {
    source: "security/politica-passwords.md",
    content:
      "Las contraseñas deben tener mínimo 12 caracteres, incluir mayúsculas, minúsculas, números y símbolos. Están prohibidas las contraseñas reutilizadas o palabras del diccionario. La rotación obligatoria es cada 90 días. Está prohibido compartir credenciales por chat o email; usar el gestor corporativo 1Password.",
  },
  {
    source: "security/politica-incidentes.md",
    content:
      "Cualquier incidente de seguridad (phishing, fuga de datos, acceso no autorizado) debe reportarse en menos de 1 hora al equipo SecOps vía Slack #sec-incidents. La omisión de reporte se considera falta grave. El equipo SecOps clasifica el incidente y activa el protocolo IR-01 si es crítico.",
  },
  {
    source: "finance/politica-gastos.md",
    content:
      "Los gastos de representación requieren aprobación del manager y ticket fiscal. Comidas con clientes: máximo 60€ por persona. Vuelos: clase turista salvo trayectos > 6h (business permitido). Hoteles: hasta 200€/noche en capitales, 150€ en resto. Reportar gastos antes del día 5 del mes siguiente.",
  },
  {
    source: "engineering/politica-code-review.md",
    content:
      "Todo cambio a main requiere al menos 2 aprobaciones: una del equipo dueño del código y otra de un senior engineer. Los PRs sin tests automatizados se rechazan automáticamente en CI. El SLA de revisión es 1 día laborable. Los cambios que tocan infraestructura requieren tag 'breaking-change' en el título.",
  },
  {
    source: "engineering/politica-deploys.md",
    content:
      "Los deploys a producción se realizan exclusivamente entre martes y jueves, 10:00-16:00h CET. Está prohibido desplegar viernes o festivos. Los rollback deben estar validados en staging primero. Cualquier deploy que toque la base de datos requiere runbook actualizado en /docs/runbooks/.",
  },
  {
    source: "legal/politica-privacidad.md",
    content:
      "Los datos personales de empleados y clientes se almacenan exclusivamente en sistemas on-premises. Está prohibido subir datos personales a servicios SaaS públicos sin aprobación del DPO. El acceso a datos de producción requiere MFA + justificación documentada. Auditorías trimestrales obligatorias.",
  },
  {
    source: "legal/politica-confidencialidad.md",
    content:
      "Toda información marcada como 'Confidencial' o 'Restringida' debe cifrarse en reposo y en tránsito. Está prohibido discutir información confidencial en espacios públicos o con familiares. El incumplimiento de esta política es causa de despido inmediato y posible acción legal.",
  },
  {
    source: "operations/politica-onboarding.md",
    content:
      "El proceso de onboarding dura 2 semanas. Semana 1: setup de equipo, accesos, reuniones con manager y equipo. Semana 2: shadowing de un buddy asignado, primera tarea entrega. El manager debe completar el checklist de onboarding dentro de los 30 días.",
  },
] as const;